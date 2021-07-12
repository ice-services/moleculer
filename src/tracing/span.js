"use strict";

const { now } = require("perf_hooks").performance;

function defProp(instance, propName, value, readOnly = false) {
	Object.defineProperty(instance, propName, {
		value,
		writable: !!readOnly,
		enumerable: false
	});
}

/**
 * Trace Span class
 *
 * @class Span
 */
class Span {

	/**
	 * Creates an instance of Span.
	 * @param {Tracer} tracer
	 * @param {String} name
	 * @param {Object?} opts
	 *
	 * @memberof Span
	 */
	constructor(tracer, name, opts) {
		defProp(this, "tracer", tracer, true);
		defProp(this, "logger", this.tracer.logger, true);
		defProp(this, "opts", opts || {});
		defProp(this, "meta", {});

		this.name = name;
		this.type = this.opts.type || "custom";
		this.id = this.opts.id || this.tracer.broker.generateUid();
		this.traceID = this.opts.traceID || this.id;
		this.parentID = this.opts.parentID;

		if (this.opts.service) {
			if (typeof this.opts.service == "string") {
				this.service = {
					name: this.opts.service,
					fullName: this.opts.service,
				};
			} else {
				this.service = {
					name: this.opts.service.name,
					version: this.opts.service.version,
					fullName: this.opts.service.fullName,
				};
			}
		}

		this.priority = this.opts.priority != null ? this.opts.priority : 5;
		this.sampled = this.opts.sampled != null ? this.opts.sampled : this.tracer.shouldSample(this);
		defProp(this, "autoActivate", this.opts.autoActivate != null ? this.opts.autoActivate : true);

		this.startTime = null;
		this.startTicks = null;
		this.finishTime = null;
		this.duration = null;

		this.error = null;

		this.logs = [];
		this.tags = {};

		if (this.opts.defaultTags)
			this.addTags(this.opts.defaultTags);

		if (this.opts.tags)
			this.addTags(this.opts.tags);
	}

	/**
	 * Start span.
	 *
	 * @param {Number?} time
	 * @returns {Span}
	 * @memberof Span
	 */
	start(time) {
		this.logger.debug(`[${this.id}] Span '${this.name}' is started.`);

		this.startTime = time || Date.now();
		this.startTicks = now();
		// console.log(`"${this.name}" start time: ${this.startTime}`);

		this.tracer.spanStarted(this);

		return this;
	}

	/**
	 * Get the current time.
	 *
	 * @returns {Number}
	 * @memberof Span
	 */
	getTime() {
		return this.startTime + now() - this.startTicks;
	}

	/**
	 * Add tags. It will be merged with previous tags.
	 *
	 * @param {Object} obj
	 * @returns {Span}
	 *
	 * @memberof Span
	 */
	addTags(obj) {
		Object.assign(this.tags, obj);

		return this;
	}

	/**
	 * Log a trace event.
	 *
	 * @param {String} name
	 * @param {Object?} fields
	 * @param {Number?} time
	 * @returns {Span}
	 * @memberof Span
	 */
	log(name, fields, time) {
		time = time || this.getTime();

		this.logs.push({
			name,
			fields: fields || {},
			time,
			elapsed: time - this.startTime
		});

		this.logger.debug(`[${this.id}] Span '${this.name}' has a new log event: ${name}.`);

		return this;
	}

	/**
	 * Set error span.
	 *
	 * @param {Error} err
	 * @memberof Span
	 */
	setError(err) {
		this.error = err != null ? err : true;

		return this;
	}

	/**
	 * Finish span.
	 *
	 * @param {Number?} time
	 * @returns {Span}
	 * @memberof Span
	 */
	finish(time) {
		this.finishTime = time ? time : this.getTime();
		this.duration = this.finishTime - this.startTime;

		// console.log(`"${this.name}" stop time: ${this.finishTime}  Duration: ${this.duration}`);

		this.logger.debug(`[${this.id}] Span '${this.name}' is finished. Duration: ${Number(this.duration).toFixed(3)} ms`, this.tags);

		this.tracer.spanFinished(this);

		return this;
	}

	/**
	 * Check the span is active or finished.
	 *
	 * @returns {boolean}
	 */
	isActive() {
		return this.finishTime == null;
	}

	/**
	 * Start a child span.
	 *
	 * @param {String} name
	 * @param {Object?} opts
	 * @returns {Span} Child span
	 * @memberof Span
	 */
	startSpan(name, opts) {
		const r = {
			traceID: this.traceID,
			parentID: this.id,
			sampled: this.sampled,
			service: this.service
		};
		return this.tracer.startSpan(name, opts ? Object.assign(r, opts) : r);
	}

}

module.exports = Span;
