/*
 * moleculer
 * Copyright (c) 2018 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

const util = require("util");
const { isString } = require("./utils");
const _ = require("lodash");
const { RequestSkippedError, MaxCallLevelError } = require("./errors");

/**
 * Merge metadata
 *
 * @param {Object} newMeta
 *
 * @private
 * @memberof Context
 */
function mergeMeta(ctx, newMeta) {
	if (newMeta)
		Object.assign(ctx.meta, newMeta);
	return ctx.meta;
}

/**
 * Context class for action calls
 *
 * @property {String} id - Context ID
 * @property {ServiceBroker} broker - Broker instance
 * @property {Action} action - Action definition
 * @property {String} [nodeID=null] - Node ID
 * @property {String} parentID - Parent Context ID
 * @property {Boolean} tracing - Enable tracing
 * @property {Number} [level=1] - Level of context
 *
 * @class Context
 */
class Context {

	/**
	 * Creates an instance of Context.
	 *
	 * @param {ServiceBroker} broker - Broker instance
	 * @param {Endpoint} endpoint
	 *
	 * @memberof Context
	 */
	constructor(broker, endpoint) {

		this.broker = broker;
		if (this.broker) {
			this.nodeID = this.broker.nodeID;
			this.id = this.broker.generateUid();
		} else {
			this.nodeID = null;
		}

		if (endpoint) {
			this.setEndpoint(endpoint);
		} else {
			this.endpoint = null;
			this.service = null;
			this.action = null;
			this.event = null;
		}

		// The emitted event "user.created" because `ctx.event.name` can be "user.**"
		this.eventName = null;
		// Type of event ("emit" or "broadcast")
		this.eventType = null;
		// The groups of event
		this.eventGroups = null;

		this.options = {
			timeout: null,
			retries: null,
		};

		this.parentID = null;
		this.caller = null;

		this.level = 1;

		this.params = null;
		this.meta = {};
		this.locals = {};

		this.requestID = this.id;

		this.tracing = null;
		this.span = null;
		this._spanStack = [];

		this.needAck = null;
		this.ackID = null;

		//this.startTime = null;
		//his.startHrTime = null;
		//this.stopTime = null;
		//this.duration = null;

		//this.error = null;
		this.cachedResult = false;
	}

	/**
	 * Create a new Context instance
	 *
	 * @param {ServiceBroker} broker
	 * @param {Endpoint} endpoint
	 * @param {Object?} params
	 * @param {Object} opts
	 * @returns {Context}
	 *
	 * @static
	 * @memberof Context
	 */
	static create(broker, endpoint, params, opts = {}) {
		const ctx = new broker.ContextFactory(broker, endpoint);

		if (endpoint != null)
			ctx.setEndpoint(endpoint);

		if (params != null) {
			let cloning = broker ? broker.options.contextParamsCloning : false;
			if (opts.paramsCloning != null)
				cloning = opts.paramsCloning;
			ctx.setParams(params, cloning);
		}

		//Object.assign(ctx.options, opts);
		ctx.options = opts;

		// RequestID
		if (opts.requestID != null)
			ctx.requestID = opts.requestID;
		else if (opts.parentCtx != null && opts.parentCtx.requestID != null)
			ctx.requestID = opts.parentCtx.requestID;

		// TraceID
		if (opts.traceID != null)
			ctx.traceID = opts.traceID;
		else if (opts.parentCtx != null && opts.parentCtx.traceID != null)
			ctx.traceID = opts.parentCtx.traceID;

		// Meta
		if (opts.parentCtx != null && opts.parentCtx.meta != null)
			ctx.meta = Object.assign({}, opts.parentCtx.meta || {}, opts.meta || {});
		else if (opts.meta != null)
			ctx.meta = opts.meta;

		// ParentID, Level, Caller, Tracing
		if (opts.parentCtx != null) {
			ctx.tracing = opts.parentCtx.tracing;
			ctx.level = opts.parentCtx.level + 1;

			if (opts.parentCtx.span)
				ctx.parentID = opts.parentCtx.span.id;
			else
				ctx.parentID = opts.parentCtx.id;

			if (opts.parentCtx.service)
				ctx.caller = opts.parentCtx.service.fullName;
		}

		// caller
		if (opts.caller) {
			ctx.caller = opts.caller;
		}

		// Parent span
		if (opts.parentSpan != null) {
			ctx.parentID = opts.parentSpan.id;
			ctx.requestID = opts.parentSpan.traceID;
			ctx.traceID = opts.parentSpan.traceID;
			ctx.tracing = opts.parentSpan.sampled;
		}

		// Event acknowledgement
		if (opts.needAck) {
			ctx.needAck = opts.needAck;
		}

		return ctx;
	}

	/**
	 * Copy itself without ID.
	 * @param {Endpoint} ep
	 * @returns {Context}
	 */
	copy(ep) {
		const newCtx = new this.constructor(this.broker);

		newCtx.nodeID = this.nodeID;
		newCtx.setEndpoint(ep || this.endpoint);
		newCtx.options = this.options;
		newCtx.parentID = this.parentID;
		newCtx.caller = this.caller;
		newCtx.level = this.level;
		newCtx.params = this.params;
		newCtx.meta = this.meta;
		newCtx.locals = this.locals;
		newCtx.requestID = this.requestID;
		newCtx.traceID = this.traceID;
		newCtx.tracing = this.tracing;
		newCtx.span = this.span;
		newCtx.needAck = this.needAck;
		newCtx.ackID = this.ackID;
		newCtx.eventName = this.eventName;
		newCtx.eventType = this.eventType;
		newCtx.eventGroups = this.eventGroups;

		newCtx.cachedResult = this.cachedResult;

		return newCtx;
	}

	/**
	 * Set endpoint of context
	 *
	 * @param {Endpoint} endpoint
	 * @memberof Context
	 */
	setEndpoint(endpoint) {
		this.endpoint = endpoint;
		if (endpoint) {
			this.nodeID = endpoint.id;
			if (endpoint.action) {
				this.action = endpoint.action;
				this.service = this.action.service;
				this.event = null;
			} else if (endpoint.event) {
				this.event =  endpoint.event;
				this.service = this.event.service;
				this.action = null;
			}
		}
	}

	/**
	 * Set params of context
	 *
	 * @param {Object} newParams
	 * @param {Boolean} cloning
	 *
	 * @memberof Context
	 */
	setParams(newParams, cloning = false) {
		if (cloning && newParams)
			this.params = Object.assign({}, newParams);
		else
			this.params = newParams;
	}

	/**
	 * Call an other action. It creates a sub-context.
	 *
	 * @param {String} actionName
	 * @param {Object?} params
	 * @param {Object?} opts
	 * @returns {Promise}
	 *
	 * @example <caption>Call an other service with params & options</caption>
	 * ctx.call("posts.get", { id: 12 }, { timeout: 1000 });
	 *
	 * @memberof Context
	 */
	call(actionName, params, _opts) {
		const opts = Object.assign({
			parentCtx: this
		}, _opts);

		if (this.options.timeout > 0 && this.startHrTime) {
			// Distributed timeout handling. Decrementing the timeout value with the elapsed time.
			// If the timeout below 0, skip the call.
			const diff = process.hrtime(this.startHrTime);
			const duration = (diff[0] * 1e3) + (diff[1] / 1e6);
			const distTimeout = this.options.timeout - duration;

			if (distTimeout <= 0) {
				return this.broker.Promise.reject(new RequestSkippedError({ action: actionName, nodeID: this.broker.nodeID }));
			}

			if (!opts.timeout || distTimeout < opts.timeout)
				opts.timeout = distTimeout;
		}

		// Max calling level check to avoid calling loops
		if (this.broker.options.maxCallLevel > 0 && this.level >= this.broker.options.maxCallLevel) {
			return this.broker.Promise.reject(new MaxCallLevelError({ nodeID: this.broker.nodeID, level: this.level }));
		}

		let p = this.broker.call(actionName, params, opts);

		// Merge metadata with sub context metadata
		return p.then(res => {
			if (p.ctx)
				mergeMeta(this, p.ctx.meta);

			return res;
		}).catch(err => {
			if (p.ctx)
				mergeMeta(this, p.ctx.meta);

			return this.broker.Promise.reject(err);
		});
	}

	mcall(def, _opts) {
		const opts = Object.assign({
			parentCtx: this
		}, _opts);

		if (this.options.timeout > 0 && this.startHrTime) {
			// Distributed timeout handling. Decrementing the timeout value with the elapsed time.
			// If the timeout below 0, skip the call.
			const diff = process.hrtime(this.startHrTime);
			const duration = (diff[0] * 1e3) + (diff[1] / 1e6);
			const distTimeout = this.options.timeout - duration;

			if (distTimeout <= 0) {
				const action = (Array.isArray(def) ? def : Object.values(def)).map(d => d.action).join(", ");
				return this.broker.Promise.reject(new RequestSkippedError({ action, nodeID: this.broker.nodeID }));
			}

			if (!opts.timeout || distTimeout < opts.timeout)
				opts.timeout = distTimeout;
		}

		// Max calling level check to avoid calling loops
		if (this.broker.options.maxCallLevel > 0 && this.level >= this.broker.options.maxCallLevel) {
			return this.broker.Promise.reject(new MaxCallLevelError({ nodeID: this.broker.nodeID, level: this.level }));
		}

		let p = this.broker.mcall(def, opts);

		// Merge metadata with sub context metadata
		return p.then(res => {
			if (Array.isArray(p.ctx) && p.ctx.length)
				p.ctx.forEach(ctx => mergeMeta(this, ctx.meta));

			return res;
		}).catch(err => {
			if (Array.isArray(p.ctx) && p.ctx.length)
				p.ctx.forEach(ctx => mergeMeta(this, ctx.meta));

			return this.broker.Promise.reject(err);
		});
	}

	/**
	 * Emit an event (grouped & balanced global event)
	 *
	 * @param {string} eventName
	 * @param {any?} payload
	 * @param {Object?} opts
	 * @returns {Promise}
	 *
	 * @example
	 * ctx.emit("user.created", { entity: user, creator: ctx.meta.user });
	 *
	 * @memberof Context
	 */
	emit(eventName, data, opts) {
		if (Array.isArray(opts) || isString(opts))
			opts = { groups: opts };
		else if (opts == null)
			opts = {};

		if (opts.groups && !Array.isArray(opts.groups))
			opts.groups = [opts.groups];

		opts.parentCtx = this;
		return this.broker.emit(eventName, data, opts);
	}

	/**
	 * Emit an event for all local & remote services
	 *
	 * @param {string} eventName
	 * @param {any?} payload
	 * @param {Object?} opts
	 * @returns {Promise}
	 *
	 * @example
	 * ctx.broadcast("user.created", { entity: user, creator: ctx.meta.user });
	 *
	 * @memberof Context
	 */
	broadcast(eventName, data, opts) {
		if (Array.isArray(opts) || isString(opts))
			opts = { groups: opts };
		else if (opts == null)
			opts = {};

		if (opts.groups && !Array.isArray(opts.groups))
			opts.groups = [opts.groups];

		opts.parentCtx = this;
		return this.broker.broadcast(eventName, data, opts);
	}

	/**
	 * Start a new child tracing span.
	 *
	 * @param {String} name
	 * @param {Object?} opts
	 * @returns {Span}
	 * @memberof Context
	 */
	startSpan(name, opts) {
		let span;
		if (this.span) {
			span = this.span.startSpan(name, Object.assign({ ctx: this }, opts));
		} else {
			span = this.broker.tracer.startSpan(name, Object.assign({ ctx: this }, opts));
		}

		this._spanStack.push(span);
		this.span = span;

		return span;
	}

	/**
	 * Finish an active span.
	 *
	 * @param {Span} span
	 * @param {Number?} time
	 */
	finishSpan(span, time) {
		if (!span.isActive()) return;

		span.finish(time);

		const idx = this._spanStack.findIndex(sp => sp == span);
		if (idx !== -1) {
			this._spanStack.splice(idx, 1);
			this.span = this._spanStack[this._spanStack.length - 1];
		} else {
			/* istanbul ignore next */
			this.service.logger.warn("This span is not assigned to this context", span);
		}
	}

	/**
	 * Convert Context to a printable POJO object.
	 */
	toJSON() {
		const res = _.pick(this, [
			"id",
			"nodeID",
			"action.name",
			"event.name",
			"service.name",
			"service.version",
			"service.fullName",
			"options",
			"parentID",
			"caller",
			"level",
			"params",
			"meta",
			//"locals",
			"requestID",
			"traceID",
			"tracing",
			"span",
			"needAck",
			"ackID",
			"eventName",
			"eventType",
			"eventGroups",
			"cachedResult"
		]);

		return res;
	}

	/* istanbul ignore next */
	[util.inspect.custom](depth, options) {
		// https://nodejs.org/docs/latest-v8.x/api/util.html#util_custom_inspection_functions_on_objects
		if (depth < 0) {
			return options.stylize("[Context]", "special");
		}

		const inner = util.inspect(this.toJSON(), options);
		return `${options.stylize("Context", "special")}< ${inner} >`;
	}
}

module.exports = Context;
