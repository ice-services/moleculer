/*
 * moleculer
 * Copyright (c) 2020 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

const _ = require("lodash");
const Exporters = require("./exporters");
//const AsyncStorage = require("../async-storage");
const RateLimiter = require("./rate-limiter");
const Span = require("./span");
const { isFunction } = require("../utils");

/**
 * Moleculer Tracer class
 */
class Tracer {

	/**
	 * Creates an instance of Tracer.
	 *
	 * @param {ServiceBroker} broker
	 * @param {Object} opts
	 * @memberof Tracer
	 */
	constructor(broker, opts) {
		this.broker = broker;
		this.logger = broker.getLogger("tracer");

		if (opts === true || opts === false)
			opts = { enabled: opts };

		this.opts = _.defaultsDeep({}, opts, {
			enabled: true,

			exporter: null,

			sampling: {
				// Constants sampling
				rate: 1.0, // 0.0 - Never, 1.0 > x > 0.0 - Fix, 1.0 - Always

				// Ratelimiting sampling https://opencensus.io/tracing/sampling/ratelimited/
				tracesPerSecond: null, // 1: 1 trace / sec, 5: 5 traces / sec, 0.1: 1 trace / 10 secs

				minPriority: null
			},

			actions: true,
			events: false,

			errorFields: ["name", "message", "code", "type", "data"],
			stackTrace: false,

			defaultTags: null,

			tags: {
				action: null,
				event: null,
			}
		});

		if (this.opts.stackTrace && this.opts.errorFields.indexOf("stack") === -1)
			this.opts.errorFields.push("stack");

		this.sampleCounter = 0;

		if (this.opts.sampling.tracesPerSecond != null && this.opts.sampling.tracesPerSecond > 0) {
			this.rateLimiter = new RateLimiter({
				tracesPerSecond: this.opts.sampling.tracesPerSecond
			});
		}

		//this.scope = new AsyncStorage(this.broker);
		//this.scope.enable();
		//this._scopeEnabled = true;

		if (this.opts.enabled)
			this.logger.info("Tracing: Enabled");
	}

	/**
	 * Initialize Tracer.
	 */
	init() {
		if (this.opts.enabled) {

			this.defaultTags = isFunction(this.opts.defaultTags) ? this.opts.defaultTags.call(this, this) : this.opts.defaultTags;

			// Create Exporter instances
			if (this.opts.exporter) {
				const exporters = Array.isArray(this.opts.exporter) ? this.opts.exporter : [this.opts.exporter];

				this.exporter = _.compact(exporters).map(r => {
					const exporter = Exporters.resolve(r);
					exporter.init(this);
					return exporter;
				});

				const exporterNames = this.exporter.map(exporter => this.broker.getConstructorName(exporter));
				this.logger.info(`Tracing exporter${exporterNames.length > 1 ? "s": ""}: ${exporterNames.join(", ")}`);
			}

		}
	}

	/**
	 * Stop Tracer.
	 */
	stop() {
		if (this.exporter) {
			return this.broker.Promise.all(this.exporter.map(r => r.stop()));
		}
		return this.broker.Promise.resolve();
	}

	/**
	 * Check tracing is enabled
	 *
	 * @returns {boolean}
	 * @memberof MetricRegistry
	 */
	isEnabled() {
		return this.opts.enabled;
	}

	/**
	 * Disable trace hooks and clear the store - noop if scope is already stopped
	 *
	 * @memberof Tracer
	 *
	stopAndClearScope() {
		if (this._scopeEnabled) {
			this.scope.stop();
			this._scopeEnabled = false;
		}
	}*/

	/**
	 * Renable the trace hooks - noop if scope is already enabled
	 *
	 * @memberof Tracer
	 *
	restartScope() {
		if (!this._scopeEnabled) {
			this.scope.enable();
			this._scopeEnabled = true;
		}
	}*/

	/**
	 * Decide that span should be sampled.
	 *
	 * @param {Span} span
	 * @returns {Boolean}
	 * @memberof Tracer
	 */
	shouldSample(span) {
		if (this.opts.sampling.minPriority != null) {
			if (span.priority < this.opts.sampling.minPriority)
				return false;
		}

		if (this.rateLimiter) {
			return this.rateLimiter.check();
		}

		if (this.opts.sampling.rate == 0)
			return false;

		if (this.opts.sampling.rate == 1)
			return true;

		if (++this.sampleCounter * this.opts.sampling.rate >= 1.0) {
			this.sampleCounter = 0;
			return true;
		}

		return false;
	}

	/**
	 * Start a new Span.
	 *
	 * @param {String} name
	 * @param {Object?} opts
	 * @returns {Span}
	 *
	 * @memberof Tracer
	 */
	startSpan(name, opts = {}) {
		let parentOpts = {};
		if (opts.parentSpan) {
			parentOpts.traceID = opts.parentSpan.traceID;
			parentOpts.parentID = opts.parentSpan.id;
			parentOpts.sampled = opts.parentSpan.sampled;
		}

		const span = new Span(this, name, Object.assign({
			type: "custom",
			defaultTags: this.defaultTags
		}, parentOpts, opts, { parentSpan: undefined }));

		span.start();

		return span;
	}

	/**
	 * Call a function with the provided span activated in the exporters' context
	 *
	 * @param {Span} span
	 * @param {Function} fn
	 */
	activate(span, fn) {
		if (this.exporter) {
			const handler = this.exporter.reduce((next, exporter) => {
				if (typeof exporter.activate === "function") {
					return exporter.activate.bind(exporter, span, next);
				}
				return next;
			}, fn);

			return handler();
		} else {
			return fn();
		}
	}

	/**
	 * Invoke Exporter method.
	 *
	 * @param {String} method
	 * @param {Array<any>} args
	 * @memberof Tracer
	 */
	invokeExporter(method, args) {
		if (this.exporter) {
			this.exporter.forEach(exporter => exporter[method].apply(exporter, args));
		}
	}

	/**
	 * Set the active span
	 *
	 * @param {Span} span
	 * @memberof Tracer
	 *
	setCurrentSpan(span) {
		const state = this.scope.getSessionData() || {
			spans: []
		};

		state.spans.push(span);
		this.scope.setSessionData(state);

		span.meta.state = state;
	}*/

	/**
	 * Remove the active span (because async block destroyed)
	 *
	 * @param {Span} span
	 * @memberof Tracer
	 *
	removeCurrentSpan(span) {
		const state = span.meta.state || this.scope.getSessionData();
		if (state && state.spans.length > 0) {
			const idx = state.spans.indexOf(span);
			if (idx >= 0)
				state.spans.splice(idx, 1);
		}
	}*/

	/**
	 * Get the current active span
	 *
	 * @returns {Span}
	 * @memberof Tracer
	 *
	getCurrentSpan() {
		const state = this.scope.getSessionData();
		return state ? state.spans[state.spans.length - 1] : null;
	}*/

	/**
	 * Get the current trace ID
	 *
	 * @returns
	 * @memberof Tracer
	 */
	getCurrentTraceID() {
		return null;
		//const span = this.getCurrentSpan();
		//return span ? span.traceID : null;
	}

	/**
	 * Get the active span ID (for the next span as parent ID)
	 *
	 * @returns
	 * @memberof Tracer
	 */
	getActiveSpanID() {
		return null;
		//const span = this.getCurrentSpan();
		//return span ? span.id : null;
	}

	/**
	 * Called when a span started. Call exporters.
	 *
	 * @param {Span} span
	 * @memberof Tracer
	 */
	spanStarted(span) {
		//this.setCurrentSpan(span);

		if (span.sampled)
			this.invokeExporter("spanStarted", [span]);
	}

	/**
	 * Called when a span finished. Call exporters.
	 *
	 * @param {Span} span
	 * @memberof Tracer
	 */
	spanFinished(span) {
		//this.removeCurrentSpan(span);

		if (span.sampled)
			this.invokeExporter("spanFinished", [span]);
	}
}

module.exports = Tracer;
