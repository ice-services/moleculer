/*
 * moleculer
 * Copyright (c) 2018 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

const _ = require("lodash");
const { isFunction, isPlainObject } = require("../utils");

module.exports = function TracingMiddleware(broker) {

	const tracer = broker.tracer;

	function tracingLocalActionMiddleware(handler, action) {
		let opts = action.tracing;
		if (opts === true || opts === false)
			opts = { enabled: !!opts };
		opts = _.defaultsDeep({}, opts, { enabled: true });

		if (opts.enabled) {
			return function tracingLocalActionMiddleware(ctx) {

				ctx.requestID = ctx.requestID || tracer.getCurrentTraceID();
				ctx.traceID = ctx.traceID || tracer.getCurrentTraceID();
				ctx.parentID = ctx.parentID || tracer.getActiveSpanID();

				const tags = {
					callingLevel: ctx.level,
					action: ctx.action ? {
						name: ctx.action.name,
						rawName: ctx.action.rawName
					} : null,
					remoteCall: ctx.nodeID !== ctx.broker.nodeID,
					callerNodeID: ctx.nodeID,
					nodeID: ctx.broker.nodeID,
					options: {
						timeout: ctx.options.timeout,
						retries: ctx.options.retries
					},
					requestID: ctx.requestID,
				};
				const globalActionTags = tracer.opts.tags.action;
				let actionTags;
				// local action tags take precedence
				if (isFunction(opts.tags)) {
					actionTags = opts.tags;
				} else if (!opts.tags && isFunction(globalActionTags)) {
					actionTags = globalActionTags;
				} else {
					// By default all params are captured. This can be overridden globally and locally
					actionTags = { ...{ params: true }, ...globalActionTags, ...opts.tags };
				}

				if (isFunction(actionTags)) {
					const res = actionTags.call(ctx.service, ctx);
					if (res)
						Object.assign(tags, res);

				} else if (isPlainObject(actionTags)) {
					if (actionTags.params === true)
						tags.params = ctx.params != null && isPlainObject(ctx.params) ? Object.assign({}, ctx.params) : ctx.params;
					else if (Array.isArray(actionTags.params))
						tags.params = _.pick(ctx.params, actionTags.params);

					if (actionTags.meta === true)
						tags.meta = ctx.meta != null ? Object.assign({}, ctx.meta) : ctx.meta;
					else if (Array.isArray(actionTags.meta))
						tags.meta = _.pick(ctx.meta, actionTags.meta);
				}

				let spanName = `action '${ctx.action.name}'`;
				if (opts.spanName) {
					switch(typeof opts.spanName) {
						case "string":
							spanName = opts.spanName;
							break;
						case "function":
							spanName = opts.spanName.call(ctx.service, ctx);
							break;
					}
				}

				const span = ctx.startSpan(spanName, {
					id: ctx.id,
					type: "action",
					traceID: ctx.traceID || ctx.requestID,
					parentID: ctx.parentID,
					service: ctx.service,
					sampled: ctx.tracing,
					autoActivate: false,
					tags
				});

				ctx.tracing = span.sampled;

				// Call the handler
				return tracer.activate(span, () => handler(ctx)).then(res => {
					const tags = {
						fromCache: ctx.cachedResult
					};

					if (isFunction(actionTags)) {
						const r = actionTags.call(ctx.service, ctx, res);
						if (r)
							Object.assign(tags, r);

					} else if (isPlainObject(actionTags)) {
						if (actionTags.response === true)
							tags.response = res != null && isPlainObject(res) ? Object.assign({}, res) : res;
						else if (Array.isArray(actionTags.response))
							tags.response = _.pick(res, actionTags.response);
					}

					span.addTags(tags);
					ctx.finishSpan(span);

					//ctx.duration = span.duration;

					return res;
				}).catch(err => {
					span.setError(err);
					ctx.finishSpan(span);

					throw err;
				});

			}.bind(this);
		}

		return handler;
	}

	function tracingLocalEventMiddleware(handler, event) {
		const service = event.service;

		let opts = event.tracing;
		if (opts === true || opts === false)
			opts = { enabled: !!opts };
		opts = _.defaultsDeep({}, opts, { enabled: true  });

		if (opts.enabled) {
			return function tracingLocalEventMiddleware(ctx) {

				ctx.requestID = ctx.requestID || tracer.getCurrentTraceID();
				ctx.traceID = ctx.traceID || tracer.getCurrentTraceID();
				ctx.parentID = ctx.parentID || tracer.getActiveSpanID();

				const tags = {
					event: {
						name: event.name,
						group: event.group
					},
					eventName: ctx.eventName,
					eventType: ctx.eventType,
					callerNodeID: ctx.nodeID,
					callingLevel: ctx.level,
					remoteCall: ctx.nodeID !== broker.nodeID,
					nodeID: broker.nodeID,
					requestID: ctx.requestID,
				};

				const globalEventTags = tracer.opts.tags.event;
				let eventTags;
				// local event tags take precedence
				if (isFunction(opts.tags)) {
					eventTags = opts.tags;
				} else if (!opts.tags && isFunction(globalEventTags)) {
					eventTags = globalEventTags;
				} else {
					// By default all params are captured. This can be overridden globally and locally
					eventTags = { ...{ params: true }, ...globalEventTags, ...opts.tags };
				}

				if (isFunction(eventTags)) {
					const res = eventTags.call(service, ctx);
					if (res)
						Object.assign(tags, res);

				} else if (isPlainObject(eventTags)) {
					if (eventTags.params === true)
						tags.params = ctx.params != null && isPlainObject(ctx.params) ? Object.assign({}, ctx.params) : ctx.params;
					else if (Array.isArray(eventTags.params))
						tags.params = _.pick(ctx.params, eventTags.params);

					if (eventTags.meta === true)
						tags.meta = ctx.meta != null ? Object.assign({}, ctx.meta) : ctx.meta;
					else if (Array.isArray(eventTags.meta))
						tags.meta = _.pick(ctx.meta, eventTags.meta);
				}

				let spanName = `event '${ctx.eventName}' in '${service.fullName}'`;
				if (opts.spanName) {
					switch(typeof opts.spanName) {
						case "string":
							spanName = opts.spanName;
							break;
						case "function":
							spanName = opts.spanName.call(service, ctx);
							break;
					}
				}

				const span = ctx.startSpan(spanName, {
					id: ctx.id,
					type: "event",
					traceID: ctx.traceID || ctx.requestID,
					parentID: ctx.parentID,
					service,
					sampled: ctx.tracing,
					autoActivate: false,
					tags
				});

				ctx.tracing = span.sampled;

				// Call the handler
				return tracer.activate(span, () => handler.apply(service, arguments)).then(() => {
					ctx.finishSpan(span);
				}).catch(err => {
					span.setError(err);
					ctx.finishSpan(span);
					throw err;
				});

			}.bind(this);
		}

		return handler;
	}

	/*
	function wrapRemoteTracingMiddleware(handler) {

		if (this.options.tracing) {
			return function tracingMiddleware(ctx) {
				if (ctx.tracing == null) {
					ctx.tracing = shouldTracing(ctx);
				}
				return handler(ctx);

			}.bind(this);
		}

		return handler;
	}*/
	return {
		name: "Tracing",

		localAction: broker.isTracingEnabled() && tracer.opts.actions ? tracingLocalActionMiddleware : null,
		localEvent: broker.isTracingEnabled() && tracer.opts.events ? tracingLocalEventMiddleware : null,
		//remoteAction: wrapRemoteTracingMiddleware
	};
};
