/*
 * moleculer
 * Copyright (c) 2020 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

const P 				= require("./packets");
const { Packet } 		= require("./packets");
const E 				= require("./errors");

const { Transform } 	= require("stream");
const { METRIC }		= require("./metrics");

/**
 * Transit class
 *
 * @class Transit
 */
class Transit {

	/**
	 * Create an instance of Transit.
	 *
	 * @param {ServiceBroker} Broker instance
	 * @param {Transporter} Transporter instance
	 * @param {Object?} opts
	 *
	 * @memberof Transit
	 */
	constructor(broker, transporter, opts) {
		this.broker = broker;
		this.Promise = broker.Promise;
		this.logger = broker.getLogger("transit");
		this.nodeID = broker.nodeID;
		this.metrics = broker.metrics;
		this.instanceID = broker.instanceID;
		this.tx = transporter;
		this.opts = opts;
		this.discoverer = broker.registry.discoverer;

		this.pendingRequests = new Map();
		this.pendingReqStreams = new Map();
		this.pendingResStreams = new Map();

		/* deprecated */
		this.stat = {
			packets: {
				sent: {
					count: 0,
					bytes: 0
				},
				received: {
					count: 0,
					bytes: 0
				}
			}
		};

		this.connected = false;
		this.disconnecting = false;
		this.isReady = false;

		const wrappedMessageHandler = (cmd, packet) => this.messageHandler(cmd, packet);

		this.publish = this.broker.wrapMethod("transitPublish", this.publish, this);
		this.messageHandler = this.broker.wrapMethod("transitMessageHandler", this.messageHandler, this);


		if (this.tx) {
			this.tx.init(this, wrappedMessageHandler, this.afterConnect.bind(this));

			this.tx.send = this.broker.wrapMethod("transporterSend", this.tx.send, this.tx);
			this.tx.receive = this.broker.wrapMethod("transporterReceive", this.tx.receive, this.tx, { reverse: true });
		}

		this.__connectResolve = null;

		this.registerMoleculerMetrics();
	}

	/**
	 * Register Moleculer Transit Core metrics.
	 */
	registerMoleculerMetrics() {
		if (!this.broker.isMetricsEnabled()) return;

		this.metrics.register({ name: METRIC.MOLECULER_TRANSIT_READY, type: METRIC.TYPE_GAUGE, description: "Transit is ready" }).set(0);
		this.metrics.register({ name: METRIC.MOLECULER_TRANSIT_CONNECTED, type: METRIC.TYPE_GAUGE, description: "Transit is connected" }).set(0);

		this.metrics.register({ name: METRIC.MOLECULER_TRANSIT_PONG_TIME, type: METRIC.TYPE_GAUGE, labelNames: ["targetNodeID"], description: "Ping time" });
		this.metrics.register({ name: METRIC.MOLECULER_TRANSIT_PONG_SYSTIME_DIFF, type: METRIC.TYPE_GAUGE, labelNames: ["targetNodeID"], description: "System time difference between nodes" });

		this.metrics.register({ name: METRIC.MOLECULER_TRANSIT_ORPHAN_RESPONSE_TOTAL, type: METRIC.TYPE_COUNTER, description: "Number of orphan responses" });
	}

	/**
	 * It will be called after transporter connected or reconnected.
	 *
	 * @param {any} wasReconnect
	 * @returns {Promise}
	 *
	 * @memberof Transit
	 */
	afterConnect(wasReconnect) {
		return this.Promise.resolve()

			.then(() => {
				if (wasReconnect) {
					// After reconnecting, we should send a broadcast INFO packet because there may new nodes.
					// In case of disabled balancer, it triggers the `makeBalancedSubscriptions` method.
					return this.discoverer.sendLocalNodeInfo();
				} else {
					// After connecting we should subscribe to topics
					return this.makeSubscriptions();
				}
			})

			.then(() => this.discoverer.discoverAllNodes())
			.delay(500) // Waiting for incoming INFO packets

			.then(() => {
				this.connected = true;
				this.metrics.set(METRIC.MOLECULER_TRANSIT_CONNECTED, 1);

				this.broker.broadcastLocal("$transporter.connected", { wasReconnect: !!wasReconnect });

				if (this.__connectResolve) {
					this.__connectResolve();
					this.__connectResolve = null;
				}

				return null;
			});
	}

	/**
	 * Connect with transporter. If failed, try again after 5 sec.
	 *
	 * @memberof Transit
	 */
	connect() {
		this.logger.info("Connecting to the transporter...");
		return new this.Promise(resolve => {
			this.__connectResolve = resolve;

			const doConnect = () => {
				let reconnectStarted = false;

				/* istanbul ignore next */
				const errorHandler = (err) => {
					if (this.disconnecting) return;
					if (reconnectStarted) return;

					this.logger.warn("Connection is failed.", err && err.message || "Unknown error");
					this.logger.debug(err);

					if (this.opts.disableReconnect) {
						return;
					}

					reconnectStarted = true;

					setTimeout(() => {
						this.logger.info("Reconnecting...");
						doConnect();
					}, 5 * 1000);
				};
				/* istanbul ignore next */
				this.tx.connect(errorHandler).catch(errorHandler);
			};

			doConnect();

		});
	}

	/**
	 * Disconnect with transporter
	 *
	 * @memberof Transit
	 */
	disconnect() {
		this.connected = false;
		this.isReady = false;
		this.disconnecting = true;
		this.metrics.set(METRIC.MOLECULER_TRANSIT_CONNECTED, 0);

		this.broker.broadcastLocal("$transporter.disconnected", { graceFul: true });

		return this.Promise.resolve()
			.then(() => {
				if (this.tx.connected) {
					return this.discoverer.localNodeDisconnected()
						.then(() => this.tx.disconnect());
				}
			})
			.then(() => this.disconnecting = false);
	}

	/**
	 * Local broker is ready (all services loaded).
	 * Send INFO packet to all other nodes
	 */
	ready() {
		if (this.connected) {
			this.isReady = true;
			this.metrics.set(METRIC.MOLECULER_TRANSIT_READY, 1);
			return this.discoverer.localNodeReady();
		}
	}

	/**
	 * Send DISCONNECT to remote nodes
	 *
	 * @returns {Promise}
	 *
	 * @memberof Transit
	 */
	sendDisconnectPacket() {
		return this.publish(new Packet(P.PACKET_DISCONNECT)).catch(/* istanbul ignore next */ err => this.logger.debug("Unable to send DISCONNECT packet.", err));
	}

	/**
	 * Subscribe to topics for transportation
	 *
	 * @memberof Transit
	 */
	makeSubscriptions() {
		this.subscribing = this.tx.makeSubscriptions([

			// Subscribe to broadcast events
			{ cmd: P.PACKET_EVENT, nodeID: this.nodeID },

			// Subscribe to requests
			{ cmd: P.PACKET_REQUEST, nodeID: this.nodeID },

			// Subscribe to node responses of requests
			{ cmd: P.PACKET_RESPONSE, nodeID: this.nodeID },

			// Discover handler
			{ cmd: P.PACKET_DISCOVER },
			{ cmd: P.PACKET_DISCOVER, nodeID: this.nodeID },

			// NodeInfo handler
			{ cmd: P.PACKET_INFO }, // Broadcasted INFO. If a new node connected
			{ cmd: P.PACKET_INFO, nodeID: this.nodeID }, // Response INFO to DISCOVER packet

			// Disconnect handler
			{ cmd: P.PACKET_DISCONNECT },

			// Heartbeat handler
			{ cmd: P.PACKET_HEARTBEAT },

			// Ping handler
			{ cmd: P.PACKET_PING }, // Broadcasted
			{ cmd: P.PACKET_PING, nodeID: this.nodeID }, // Targeted

			// Pong handler
			{ cmd: P.PACKET_PONG, nodeID: this.nodeID }

		]).then(() => {
			this.subscribing = null;
		});

		return this.subscribing;
	}

	/**
	 * Message handler for incoming packets
	 *
	 * @param {Array} topic
	 * @param {String} msg
	 * @returns {Boolean} If packet is processed return with `true`
	 *
	 * @memberof Transit
	 */
	messageHandler(cmd, packet) {
		try {
			const payload = packet.payload;

			// Check payload
			if (!payload) {
				/* istanbul ignore next */
				throw new E.MoleculerServerError("Missing response payload.", 500, "MISSING_PAYLOAD");
			}

			// Check protocol version
			if (payload.ver !== this.broker.PROTOCOL_VERSION && !this.opts.disableVersionCheck) {
				throw new E.ProtocolVersionMismatchError({
					nodeID: payload.sender,
					actual: this.broker.PROTOCOL_VERSION,
					received: payload.ver
				});
			}

			if (payload.sender === this.nodeID) {

				// Detect nodeID conflict
				if (cmd === P.PACKET_INFO && payload.instanceID !== this.instanceID) {
					return this.broker.fatal("ServiceBroker has detected a nodeID conflict, use unique nodeIDs. ServiceBroker stopped.");
				}

				// Skip own packets (if only built-in balancer disabled)
				if (cmd !== P.PACKET_EVENT && cmd !== P.PACKET_REQUEST && cmd !== P.PACKET_RESPONSE)
					return;
			}

			// Request
			if (cmd === P.PACKET_REQUEST) {
				return this.requestHandler(payload);
			}

			// Response
			else if (cmd === P.PACKET_RESPONSE) {
				this.responseHandler(payload);
			}

			// Event
			else if (cmd === P.PACKET_EVENT) {
				this.eventHandler(payload);
			}

			// Discover
			else if (cmd === P.PACKET_DISCOVER) {
				this.discoverer.sendLocalNodeInfo(payload.sender);
			}

			// Node info
			else if (cmd === P.PACKET_INFO) {
				this.discoverer.processRemoteNodeInfo(payload.sender, payload);
			}

			// Disconnect
			else if (cmd === P.PACKET_DISCONNECT) {
				this.discoverer.remoteNodeDisconnected(payload.sender, false);
			}

			// Heartbeat
			else if (cmd === P.PACKET_HEARTBEAT) {
				this.discoverer.heartbeatReceived(payload.sender, payload);
			}

			// Ping
			else if (cmd === P.PACKET_PING) {
				this.sendPong(payload);
			}

			// Pong
			else if (cmd === P.PACKET_PONG) {
				this.processPong(payload);
			}

			return true;
		} catch (err) {
			this.logger.error(err, cmd, packet);
		}
		return false;
	}

	/**
	 * Handle incoming event
	 *
	 * @param {any} payload
	 * @memberof Transit
	 */
	eventHandler(payload) {
		this.logger.debug(`Event '${payload.event}' received from '${payload.sender}' node` + (payload.groups ? ` in '${payload.groups.join(", ")}' group(s)` : "") + ".");

		if (!this.broker.started) {
			this.logger.warn(`Incoming '${payload.event}' event from '${payload.sender}' node is dropped, because broker is stopped.`);
			return;
		}

		// Create caller context
		const ctx = new this.broker.ContextFactory(this.broker);
		ctx.id = payload.id;
		ctx.eventName = payload.event;
		ctx.setParams(payload.data, this.broker.options.contextParamsCloning);
		ctx.eventGroups = payload.groups;
		ctx.eventType = payload.broadcast ? "broadcast" : "emit";
		ctx.meta = payload.meta || {};
		ctx.level = payload.level;
		ctx.tracing = !!payload.tracing;
		ctx.parentID = payload.parentID;
		ctx.traceID = payload.traceID;
		ctx.requestID = payload.requestID;
		ctx.caller = payload.caller;
		ctx.nodeID = payload.sender;

		this.broker.emitLocalServices(ctx);
	}

	/**
	 * Handle incoming request
	 *
	 * @param {Object} payload
	 *
	 * @memberof Transit
	 */
	requestHandler(payload) {
		this.logger.debug(`<= Request '${payload.action}' received from '${payload.sender}' node.`);

		try {
			if (!this.broker.started) {
				this.logger.warn(`Incoming '${payload.action}' request from '${payload.sender}' node is dropped because broker is stopped.`);
				throw new E.ServiceNotAvailableError({ action: payload.action, nodeID: this.nodeID });
			}

			let pass;
			if (payload.stream !== undefined) {
				pass = this._handleIncomingRequestStream(payload);
				if (pass === null) // eslint-disable-line security/detect-possible-timing-attacks
					return this.Promise.resolve();
			}

			const endpoint = this.broker._getLocalActionEndpoint(payload.action);

			// Recreate caller context
			const ctx = new this.broker.ContextFactory(this.broker);
			ctx.setEndpoint(endpoint);
			ctx.id = payload.id;
			ctx.setParams(pass ? pass : payload.params, this.broker.options.contextParamsCloning);
			ctx.parentID = payload.parentID;
			ctx.traceID = payload.traceID;
			ctx.requestID = payload.requestID;
			ctx.caller = payload.caller;
			ctx.meta = payload.meta || {};
			ctx.level = payload.level;
			ctx.tracing = payload.tracing;
			ctx.nodeID = payload.sender;

			if (payload.timeout != null)
				ctx.options.timeout = payload.timeout;

			const p = endpoint.action.handler(ctx);
			// Pointer to Context
			p.ctx = ctx;

			return p
				.then(res => this.sendResponse(payload.sender, payload.id, ctx.meta, res, null))
				.catch(err => this.sendResponse(payload.sender, payload.id, ctx.meta, null, err));

		} catch (err) {
			return this.sendResponse(payload.sender, payload.id, payload.meta, null, err);
		}
	}

	/**
	 * Handle incoming request stream.
	 *
	 * @param {Object} payload
	 * @returns {Stream}
	 */
	_handleIncomingRequestStream(payload) {
		let pass = this.pendingReqStreams.get(payload.id);
		let isNew = false;

		if (!payload.stream && !pass) {
			// It is not a stream data
			return false;
		}

		if (!pass) {
			isNew = true;
			this.logger.debug(`<= New stream is received from '${payload.sender}'. Seq: ${payload.seq}`);

			// Create a new pass stream
			pass = new Transform({
				objectMode: payload.meta && payload.meta["$streamObjectMode"],
				transform: function(chunk, encoding, done) {
					this.push(chunk);
					return done();
				}
			});

			pass.$prevSeq = -1;
			pass.$pool = new Map();

			this.pendingReqStreams.set(payload.id, pass);
		}

		if (payload.seq > pass.$prevSeq + 1) {
			// Some chunks are late. Store these chunks.
			this.logger.info(`Put the chunk into pool (size: ${pass.$pool.size}). Seq: ${payload.seq}`);

			pass.$pool.set(payload.seq, payload);

			// TODO: start timer.
			// TODO: check length of pool.
			// TODO: reset seq

			return isNew ? pass : null;
		}

		// the next stream chunk received
		pass.$prevSeq = payload.seq;

		if (pass.$prevSeq > 0) {
			if (!payload.stream) {

				// Check stream error
				if (payload.meta && payload.meta["$streamError"]) {
					pass.emit("error", this._createErrFromPayload(payload.meta["$streamError"], payload.sender));
				}

				this.logger.debug(`<= Stream closing is received from '${payload.sender}'. Seq: ${payload.seq}`);

				// End of stream
				pass.end();

				// Remove pending request stream
				this.pendingReqStreams.delete(payload.id);

				return null;

			} else {
				this.logger.debug(`<= Stream chunk is received from '${payload.sender}'. Seq: ${payload.seq}`);
				pass.write(payload.params.type === "Buffer" ? Buffer.from(payload.params.data) : payload.params);
			}
		}

		// Check newer chunks in the pool
		if (pass.$pool.size > 0) {
			this.logger.warn(`Has stored packets. Size: ${pass.$pool.size}`);
			const nextSeq = pass.$prevSeq + 1;
			const nextPacket = pass.$pool.get(nextSeq);
			if (nextPacket) {
				pass.$pool.delete(nextSeq);
				setImmediate(() => this.requestHandler(nextPacket));
			}
		}

		return isNew ? pass : null;
	}

	/**
	 * Create an Error instance from payload ata
	 * @param {Object} error
	 * @param {String} sender
	 */
	_createErrFromPayload(error, sender) {
		let err = E.recreateError(error);
		if (!err) {
			err = new Error(error.message);
			err.name = error.name;
			err.code = error.code;
			err.type = error.type;
			err.data = error.data;
		}
		err.retryable = error.retryable;
		err.nodeID = error.nodeID || sender;

		if (error.stack)
			err.stack = error.stack;

		return err;
	}

	/**
	 * Process incoming response of request
	 *
	 * @param {Object} packet
	 *
	 * @memberof Transit
	 */
	responseHandler(packet) {
		const id = packet.id;
		const req = this.pendingRequests.get(id);

		// If not exists (timed out), we skip response processing
		if (req == null) {
			this.logger.debug("Orphan response is received. Maybe the request is timed out earlier. ID:", packet.id, ", Sender:", packet.sender);
			this.metrics.increment(METRIC.MOLECULER_TRANSIT_ORPHAN_RESPONSE_TOTAL);
			return;
		}

		this.logger.debug(`<= Response '${req.action.name}' is received from '${packet.sender}'.`);

		// Update nodeID in context (if it uses external balancer)
		req.ctx.nodeID = packet.sender;

		// Merge response meta with original meta
		Object.assign(req.ctx.meta || {}, packet.meta || {});

		// Handle stream response
		if (packet.stream != null) {
			if (this._handleIncomingResponseStream(packet, req))
				return;
		}

		// Remove pending request
		this.removePendingRequest(id);

		if (!packet.success) {
			req.reject(this._createErrFromPayload(packet.error, packet.sender));
		} else {
			req.resolve(packet.data);
		}
	}

	/**
	 * Handle incoming response stream.
	 *
	 * @param {Object} packet
	 * @param {Object} req
	 */
	_handleIncomingResponseStream(packet, req) {
		let pass = this.pendingResStreams.get(packet.id);
		if (!pass && !packet.stream)
			return false;

		if (!pass) {
			this.logger.debug(`<= New stream is received from '${packet.sender}'. Seq: ${packet.seq}`);

			pass = new Transform({
				objectMode: packet.meta && packet.meta["$streamObjectMode"],
				transform: function(chunk, encoding, done) {
					this.push(chunk);
					return done();
				}
			});

			pass.$prevSeq = -1;
			pass.$pool = new Map();

			this.pendingResStreams.set(packet.id, pass);

			req.resolve(pass);
		}

		if (packet.seq > pass.$prevSeq + 1) {
			// Some chunks are late. Store these chunks.
			this.logger.info(`Put the chunk into pool (size: ${pass.$pool.size}). Seq: ${packet.seq}`);

			pass.$pool.set(packet.seq, packet);

			// TODO: start timer.
			// TODO: check length of pool.
			// TODO: resetting seq.

			return true;
		}

		// the next stream chunk received
		pass.$prevSeq = packet.seq;

		if (pass.$prevSeq > 0) {

			if (!packet.stream) {
				// Received error?
				if (!packet.success)
					pass.emit("error", this._createErrFromPayload(packet.error, packet.sender));

				this.logger.debug(`<= Stream closing is received from '${packet.sender}'. Seq: ${packet.seq}`);

				// End of stream
				pass.end();

				// Remove pending request
				this.removePendingRequest(packet.id);

				return true;

			} else {
				// stream chunk
				this.logger.debug(`<= Stream chunk is received from '${packet.sender}'. Seq: ${packet.seq}`);
				pass.write(packet.data.type === "Buffer" ? Buffer.from(packet.data.data):packet.data);
			}
		}

		// Check newer chunks in the pool
		if (pass.$pool.size > 0) {
			this.logger.warn(`Has stored packets. Size: ${pass.$pool.size}`);
			const nextSeq = pass.$prevSeq + 1;
			const nextPacket = pass.$pool.get(nextSeq);
			if (nextPacket) {
				pass.$pool.delete(nextSeq);
				setImmediate(() => this.responseHandler(nextPacket));
			}
		}

		return true;
	}


	/**
	 * Send a request to a remote service. It returns a Promise
	 * what will be resolved when the response received.
	 *
	 * @param {<Context>} ctx Context of request
	 * @returns {Promise}
	 *
	 * @memberof Transit
	 */
	request(ctx) {
		if (this.opts.maxQueueSize && this.pendingRequests.size >= this.opts.maxQueueSize)
			/* istanbul ignore next */
			return this.Promise.reject(new E.QueueIsFullError({
				action: ctx.action.name,
				nodeID: this.nodeID,
				size: this.pendingRequests.size,
				limit: this.opts.maxQueueSize
			}));

		// Expanded the code that v8 can optimize it.  (TryCatchStatement disable optimizing)
		return new this.Promise((resolve, reject) => this._sendRequest(ctx, resolve, reject));
	}

	/**
	 * Send a remote request
	 *
	 * @param {<Context>} ctx      Context of request
	 * @param {Function} resolve   Resolve of Promise
	 * @param {Function} reject    Reject of Promise
	 *
	 * @memberof Transit
	 */
	_sendRequest(ctx, resolve, reject) {
		const isStream = ctx.params && ctx.params.readable === true && typeof ctx.params.on === "function" && typeof ctx.params.pipe === "function";

		const request = {
			action: ctx.action,
			nodeID: ctx.nodeID,
			ctx,
			resolve,
			reject,
			stream: isStream // ???
		};

		const payload = {
			id: ctx.id,
			action: ctx.action.name,
			params: isStream ? null : ctx.params,
			meta: ctx.meta,
			timeout: ctx.options.timeout,
			level: ctx.level,
			tracing: ctx.tracing,
			parentID: ctx.parentID,
			traceID: ctx.traceID,
			requestID: ctx.requestID,
			caller: ctx.caller,
			stream: isStream,
		};

		if (payload.stream) {
			if (ctx.params.readableObjectMode === true || (ctx.params._readableState && ctx.params._readableState.objectMode === true)) {
				payload.meta = payload.meta || {};
				payload.meta["$streamObjectMode"] = true;
			}
			payload.seq = 0;
		}

		const packet = new Packet(P.PACKET_REQUEST, ctx.nodeID, payload);

		const nodeName = ctx.nodeID ? `'${ctx.nodeID}'` : "someone";
		this.logger.debug(`=> Send '${ctx.action.name}' request to ${nodeName} node.`);

		const publishCatch = /* istanbul ignore next */ err => this.logger.error(`Unable to send '${ctx.action.name}' request to ${nodeName} node.`, err);

		// Add to pendings
		this.pendingRequests.set(ctx.id, request);

		// Publish request
		return this.publish(packet)
			.then(() => {
				if (isStream) {
					// Skip to send ctx.meta with chunks because it doesn't appear on the remote side.
					payload.meta = {};
					// Still send information about objectMode in case of packets are received in wrong order
					if (ctx.params.readableObjectMode === true || (ctx.params._readableState && ctx.params._readableState.objectMode === true)) {
						payload.meta["$streamObjectMode"] = true;
					}

					const stream = ctx.params;
					stream.on("data", (chunk) => {
						stream.pause();
						const chunks = [];
						if (chunk instanceof Buffer && this.opts.maxChunkSize > 0 && chunk.length > this.opts.maxChunkSize) {
							let len = chunk.length;
							let i = 0;
							while (i < len) {
								chunks.push(chunk.slice(i, i += this.opts.maxChunkSize));
							}
						} else {
							chunks.push(chunk);
						}
						for (const ch of chunks) {
							const copy = Object.assign({}, payload);
							copy.seq = ++payload.seq;
							copy.stream = true;
							copy.params = ch;

							this.logger.debug(`=> Send stream chunk to ${nodeName} node. Seq: ${copy.seq}`);

							this.publish(new Packet(P.PACKET_REQUEST, ctx.nodeID, copy))
								.catch(publishCatch);
						}
						stream.resume();
						return;
					});

					stream.on("end", () => {
						const copy = Object.assign({}, payload);
						copy.seq = ++payload.seq;
						copy.params = null;
						copy.stream = false;

						this.logger.debug(`=> Send stream closing to ${nodeName} node. Seq: ${copy.seq}`);

						return this.publish(new Packet(P.PACKET_REQUEST, ctx.nodeID, copy))
							.catch(publishCatch);
					});

					stream.on("error", err => {
						const copy = Object.assign({}, payload);
						copy.seq = ++payload.seq;
						copy.stream = false;
						copy.meta["$streamError"] = this._createPayloadErrorField(err);
						copy.params = null;

						this.logger.debug(`=> Send stream error to ${nodeName} node.`, copy.meta["$streamError"]);

						return this.publish(new Packet(P.PACKET_REQUEST, ctx.nodeID, copy))
							.catch(publishCatch);
					});
				}
			})
			.catch(err => {
				publishCatch(err);
				reject(err);
			});
	}

	/**
	 * Send an event to a remote node.
	 * The event is balanced by transporter
	 *
	 * @param {Context} ctx
	 *
	 * @memberof Transit
	 */
	sendEvent(ctx) {
		const groups = ctx.eventGroups;
		if (ctx.endpoint)
			this.logger.debug(`=> Send '${ctx.eventName}' event to '${ctx.nodeID}' node` + (groups ? ` in '${groups.join(", ")}' group(s)` : "") + ".");
		else
			this.logger.debug(`=> Send '${ctx.eventName}' event to '${groups.join(", ")}' group(s).`);

		return this.publish(new Packet(P.PACKET_EVENT, ctx.endpoint ? ctx.nodeID : null, {
			id: ctx.id,
			event: ctx.eventName,
			data: ctx.params,
			groups,
			broadcast: ctx.eventType == "broadcast",
			meta: ctx.meta,
			level: ctx.level,
			tracing: ctx.tracing,
			parentID: ctx.parentID,
			traceID: ctx.traceID,
			requestID: ctx.requestID,
			caller: ctx.caller,
			needAck: ctx.needAck
		})).catch(/* istanbul ignore next */ err => this.logger.error(`Unable to send '${ctx.eventName}' event to groups.`, err));
	}

	/**
	 * Remove a pending request
	 *
	 * @param {any} id
	 *
	 * @memberof Transit
	 */
	removePendingRequest(id) {
		this.pendingRequests.delete(id);

		this.pendingReqStreams.delete(id);
		this.pendingResStreams.delete(id);
	}

	/**
	 * Remove a pending request & streams
	 *
	 * @param {String} nodeID
	 *
	 * @memberof Transit
	 */
	removePendingRequestByNodeID(nodeID) {
		this.logger.debug(`Remove pending requests of '${nodeID}' node.`);
		this.pendingRequests.forEach((req, id) => {
			if (req.nodeID === nodeID) {
				this.pendingRequests.delete(id);

				// Reject the request
				req.reject(new E.RequestRejectedError({
					action: req.action.name,
					nodeID: req.nodeID
				}));

				this.pendingReqStreams.delete(id);
				this.pendingResStreams.delete(id);
			}
		});
	}

	/**
	 * Create error field in outgoing payload
	 *
	 * @param {Error} err
	 * @returns {Object}
	 * @memberof Transit
	 */
	_createPayloadErrorField(err) {
		return {
			name: err.name,
			message: err.message,
			nodeID: err.nodeID || this.nodeID,
			code: err.code,
			type: err.type,
			retryable: err.retryable,
			stack: err.stack,
			data: err.data
		};
	}

	/**
	 * Send back the response of request
	 *
	 * @param {String} nodeID
	 * @param {String} id
	 * @param {any} meta
	 * @param {any} data
	 * @param {Error} err
	 *
	 * @memberof Transit
	 */
	sendResponse(nodeID, id, meta, data, err) {
		// Publish the response
		const payload = {
			id: id,
			meta: meta,
			success: err == null,
			data: data
		};

		if (err)
			payload.error = this._createPayloadErrorField(err);

		const publishCatch = /* istanbul ignore next */ err => this.logger.error(`Unable to send '${id}' response to '${nodeID}' node.`, err);

		if (data && data.readable === true && typeof data.on === "function" && typeof data.pipe === "function") {
			// Streaming response
			payload.stream = true;
			if (data.readableObjectMode === true || (data._readableState && data._readableState.objectMode === true)) {
				payload.meta = payload.meta || {};
				payload.meta["$streamObjectMode"] = true;
			}
			payload.seq = 0;

			const stream = data;
			stream.pause();

			stream.on("data", (chunk) => {
				stream.pause();
				const chunks = [];
				if (chunk instanceof Buffer && this.opts.maxChunkSize > 0 && chunk.length > this.opts.maxChunkSize) {
					let len = chunk.length;
					let i = 0;
					while (i < len) {
						chunks.push(chunk.slice(i, i += this.opts.maxChunkSize));
					}
				} else {
					chunks.push(chunk);
				}
				for (const ch of chunks) {
					const copy = Object.assign({}, payload);
					copy.seq = ++payload.seq;
					copy.stream = true;
					copy.data = ch;

					this.logger.debug(`=> Send stream chunk to ${nodeID} node. Seq: ${copy.seq}`);

					this.publish(new Packet(P.PACKET_RESPONSE, nodeID, copy))
						.catch(publishCatch);
				}
				stream.resume();
				return;
			});

			stream.on("end", () => {
				const copy = Object.assign({}, payload);
				copy.stream = false;
				copy.seq = ++payload.seq;
				copy.data = null;

				this.logger.debug(`=> Send stream closing to ${nodeID} node. Seq: ${copy.seq}`);

				return this.publish(new Packet(P.PACKET_RESPONSE, nodeID, copy))
					.catch(publishCatch);
			});

			stream.on("error", err => {
				const copy = Object.assign({}, payload);
				copy.stream = false;
				copy.seq = ++payload.seq;
				if (err) {
					copy.success = false;
					copy.error = this._createPayloadErrorField(err);
				}

				this.logger.debug(`=> Send stream error to ${nodeID} node.`, copy.error);

				return this.publish(new Packet(P.PACKET_RESPONSE, nodeID, copy))
					.catch(publishCatch);
			});

			payload.data = null;
			return this.publish(new Packet(P.PACKET_RESPONSE, nodeID, payload))
				.then(() => {
					if (payload.stream)
						stream.resume();
				})
				.catch(publishCatch);

		}

		return this.publish(new Packet(P.PACKET_RESPONSE, nodeID, payload))
			.catch(publishCatch);
	}

	/**
	 * Discover other nodes. It will be called after success connect.
	 *
	 * @memberof Transit
	 */
	discoverNodes() {
		return this.publish(new Packet(P.PACKET_DISCOVER))
			.catch(/* istanbul ignore next */ err => this.logger.error("Unable to send DISCOVER packet.", err));
	}

	/**
	 * Discover a node. It will be called if we got message from an unknown node.
	 *
	 * @memberof Transit
	 */
	discoverNode(nodeID) {
		return this.publish(new Packet(P.PACKET_DISCOVER, nodeID))
			.catch(/* istanbul ignore next */ err => this.logger.error(`Unable to send DISCOVER packet to '${nodeID}' node.`, err));
	}

	/**
	 * Send node info package to other nodes.
	 *
	 * @memberof Transit
	 */
	sendNodeInfo(info, nodeID) {
		if (!this.connected || !this.isReady) return this.Promise.resolve();

		return this.publish(new Packet(P.PACKET_INFO, nodeID, {
			services: info.services,
			ipList: info.ipList,
			hostname: info.hostname,
			client: info.client,
			config: info.config,
			instanceID: this.broker.instanceID,
			metadata: info.metadata,
			seq: info.seq
		})).catch(/* istanbul ignore next */ err => this.logger.error(`Unable to send INFO packet to '${nodeID}' node.`, err));

	}

	/**
	 * Send ping to a node (or all nodes if nodeID is null)
	 *
	 * @param {String} nodeID
	 * @param {String} id
	 * @returns
	 * @memberof Transit
	 */
	sendPing(nodeID, id) {
		return this.publish(new Packet(P.PACKET_PING, nodeID, { time: Date.now(), id: id || this.broker.generateUid() }))
			.catch(/* istanbul ignore next */ err => this.logger.error(`Unable to send PING packet to '${nodeID}' node.`, err));
	}

	/**
	 * Send back pong response
	 *
	 * @param {Object} payload
	 * @returns
	 * @memberof Transit
	 */
	sendPong(payload) {
		return this.publish(new Packet(P.PACKET_PONG, payload.sender, {
			time: payload.time,
			id: payload.id,
			arrived: Date.now()
		})).catch(/* istanbul ignore next */ err => this.logger.error(`Unable to send PONG packet to '${payload.sender}' node.`, err));
	}

	/**
	 * Process incoming PONG packet.
	 * Measure ping time & current time difference.
	 *
	 * @param {Object} payload
	 * @memberof Transit
	 */
	processPong(payload) {
		const now = Date.now();
		const elapsedTime = now - payload.time;
		const timeDiff = Math.round(now - payload.arrived - elapsedTime / 2);

		// this.logger.debug(`PING-PONG from '${payload.sender}' - Time: ${elapsedTime}ms, Time difference: ${timeDiff}ms`);

		this.broker.broadcastLocal("$node.pong", { nodeID: payload.sender, elapsedTime, timeDiff, id: payload.id });

		this.metrics.set(METRIC.MOLECULER_TRANSIT_PONG_TIME, elapsedTime, { targetNodeID: payload.sender });
		this.metrics.set(METRIC.MOLECULER_TRANSIT_PONG_SYSTIME_DIFF, timeDiff, { targetNodeID: payload.sender });
	}

	/**
	 * Send a node heartbeat. It will be called with timer from local Discoverer.
	 *
	 * @params {Node} localNode
	 * @memberof Transit
	 */
	sendHeartbeat(localNode) {
		return this.publish(new Packet(P.PACKET_HEARTBEAT, null, {
			cpu: localNode.cpu
		})).catch(/* istanbul ignore next */ err => this.logger.error("Unable to send HEARTBEAT packet.", err));

	}

	/**
	 * Subscribe via transporter
	 *
	 * @param {String} topic
	 * @param {String=} nodeID
	 *
	 * @deprecated
	 * @memberof Transit
	 */
	subscribe(topic, nodeID) {
		return this.tx.subscribe(topic, nodeID);
	}

	/**
	 * Publish via transporter
	 *
	 * @param {Packet} Packet
	 *
	 * @memberof Transit
	 */
	publish(packet) {
		if (this.subscribing) {
			return this.subscribing
				.then(() => {
					return this.tx.prepublish(packet);
				});
		}
		return this.tx.prepublish(packet);
	}

}

module.exports = Transit;
