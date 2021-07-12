"use strict";

const _ = require("lodash");
const H = require("./helpers");
const semver = require("semver");
const BaseLogger = require("../../src/loggers/base");

// Mock agent exporter to avoid failed network requests
jest.mock("dd-trace/packages/dd-trace/src/exporters/agent");

/**
 * A logger that captures records associated with an active trace
 */
class TraceCaptureLogger extends BaseLogger {
	constructor(opts) {
		super(opts);
		this.logs = [];
	}
	getLogHandler(bindings) {
		const level = bindings ? this.getLogLevel(bindings.mod) : null;
		if (!level) return null;

		const levelIdx = BaseLogger.LEVELS.indexOf(level);

		return (type, args) => {
			const typeIdx = BaseLogger.LEVELS.indexOf(type);
			if (typeIdx > levelIdx) return;

			const record = {
				ts: Date.now(),
				level: type,
				msg: args.join(" "),
				dd: {},
				...bindings,
			};

			const traceId =
				this.broker.tracer && this.broker.tracer.getCurrentTraceID();
			if (traceId && record.mod !== "tracer") {
				record.dd.trace_id = traceId;
				record.dd.span_id = this.broker.tracer.getActiveSpanID();
				this.logs.push(record);
			}
		};
	}
}

// Build list of supported Scope implementations to test
let supportedScopes = ["async_hooks"];
if (semver.satisfies(process.versions.node, ">=14.5 || ^12.19.0")) {
	supportedScopes.push("async_resource");
	supportedScopes.push("async_local_storage");
}

supportedScopes.forEach((scope) => {
	describe(`Test Tracing Datadog exporter - ${scope} scope`, () => {
		let STORE = [];
		let broker = null;

		const COMMON_SETTINGS = {
			logger: false,
			logLevel: "debug",
			namespace: `tracing-${scope}`,
			tracing: {
				enabled: true,
				actions: true,
				events: true,
				sampling: {
					rate: 1,
				},
				exporter: [
					{
						type: "Datadog",
						options: {
							tracerOptions: {
								scope,
							},
							defaultTags: {
								scope,
							},
						},
					},
					{
						type: "Event",
						options: {
							interval: 0,
						},
					},
				],
			},
		};

		const TestTracingService = {
			name: "tracing-collector",
			events: {
				"$tracing.spans"(ctx) {
					STORE.push(...ctx.params);
				},
				async "some.event"(ctx) {
					STORE.push(this.getActiveSpan());
					const span = ctx.startSpan("custom span");
					STORE.push(this.getActiveSpan());
					await new Promise((r) => setTimeout(r, 100));
					STORE.push(this.getActiveSpan());
					ctx.finishSpan(span);
					STORE.push(this.getActiveSpan());
				},
			},
			actions: {
				async echo(ctx) {
					await new Promise((r) => setTimeout(r, 100));
					return ctx.params;
				},

				async getSpan() {
					return this.getActiveSpan();
				},

				async triggerEvent(ctx) {
					STORE.push(this.getActiveSpan());
					await ctx.emit("some.event", { foo: "bar" });
				},

				async log(ctx) {
					this.logger.info(
						`Called with param value=${ctx.params.value}`
					);
					if (ctx.params.recurse) {
						await ctx.call(ctx.action.name, {
							value: `double ${ctx.params.value}`,
							recurse: false,
						});
					}
				},

				async customSpans(ctx) {
					const spans = [this.getActiveSpan()];

					// parent
					const span1 = ctx.startSpan("span1");
					await new Promise((r) => setTimeout(r, 100));
					spans.push(this.getActiveSpan());

					// child
					const span2 = ctx.startSpan("span2");
					await new Promise((r) => setTimeout(r, 50));
					spans.push(this.getActiveSpan());
					ctx.finishSpan(span2);

					spans.push(this.getActiveSpan());
					ctx.finishSpan(span1);

					// independent
					const span3 = ctx.startSpan("span3");
					await new Promise((r) => setTimeout(r, 250)).then(() => {
						spans.push(this.getActiveSpan());
						ctx.finishSpan(span3);

						spans.push(this.getActiveSpan());
					});

					// spans == [action, span1, span2, span1, span3, action]
					return spans;
				},
			},

			methods: {
				getActiveSpan() {
					const span = this.broker.tracer.exporter[0].ddTracer
						.scope()
						.active();

					if (!span) return null;

					const context = span.context();

					return {
						traceId: context.toTraceId(),
						spanId: context.toSpanId(),
						parentId: context._parentId
							? context._parentId.toString(10)
							: null,
						name: context._name,
						tags: context._tags,
					};
				},
			},
		};

		beforeAll(() => {
			// Reset dd-trace module so it can be reinitialized with the new scope setting
			jest.resetModules();
			broker = H.createNode(
				_.defaultsDeep(
					{ nodeID: `broker-${scope}-0` },
					COMMON_SETTINGS
				),
				[TestTracingService]
			);
			return broker.start();
		});

		afterAll(() => {
			// Some cleanup to avoid affecting other test suites
			if (["async_hooks", "async_resource"].includes(scope)) {
				broker.tracer.exporter[0].ddScope._hook.disable();
			} else if (scope === "async_local_storage") {
				broker.tracer.exporter[0].ddScope._storage.disable();
			}
			return broker.stop();
		});

		beforeEach(() => {
			jest.resetAllMocks();
			STORE = [];
		});

		it("sets the span as active in dd-trace", async () => {
			// Get the active span from dd tracer
			const span = await broker.call("tracing-collector.getSpan", {
				foo: "bar",
			});

			// Compare dd tracer span to moleculer span
			expect(STORE).toHaveLength(1);
			expect(span).not.toBeNull();
			expect(span.traceId).toBe(
				broker.tracer.exporter[0]
					.convertID(STORE[0].traceID)
					.toString(10)
			);
			expect(span.spanId).toBe(
				broker.tracer.exporter[0].convertID(STORE[0].id).toString(10)
			);
			expect(span.parentId).toBeNull();
			expect(span.tags).toEqual(
				expect.objectContaining({
					requestID: STORE[0].tags.requestID,
					"action.name": "tracing-collector.getSpan",
					"params.foo": "bar",
				})
			);
		});

		it("has an isolated async context", async () => {
			const ddScope = broker.tracer.exporter[0].ddTracer.scope();
			expect(ddScope.active()).toBeNull();

			const request = broker.call("tracing-collector.echo", {
				phrase: "hello",
			});

			// Check sync context
			expect(ddScope.active()).toBeNull();

			await request;

			expect(ddScope.active()).toBeNull();
		});

		it("can be used with log injector", async () => {
			const loggerInstance = new TraceCaptureLogger();
			const logTestBroker = H.createNode(
				_.defaultsDeep(
					{
						nodeID: "broker-log-1",
						logLevel: "info",
						logger: loggerInstance,
					},
					COMMON_SETTINGS
				),
				[TestTracingService]
			);

			await logTestBroker.start();
			await logTestBroker.call("tracing-collector.log", {
				value: "test",
				recurse: true,
			});
			await logTestBroker.stop();

			// Expect only 2 logs. If more, span context is not being properly deactivated
			expect(loggerInstance.logs).toHaveLength(2);

			// Expect logger to be called with injected log
			const log1 = loggerInstance.logs[0];
			expect(log1).toEqual({
				ts: expect.any(Number),
				level: "info",
				msg: "Called with param value=test",
				dd: {
					trace_id: expect.any(String),
					span_id: expect.any(String),
				},
				nodeID: "broker-log-1",
				ns: `tracing-${scope}`,
				mod: "tracing-collector",
				svc: "tracing-collector",
			});

			const log2 = loggerInstance.logs[1];
			expect(log2).toEqual({
				ts: expect.any(Number),
				level: "info",
				msg: "Called with param value=double test",
				dd: {
					trace_id: expect.any(String),
					span_id: expect.any(String),
				},
				nodeID: "broker-log-1",
				ns: `tracing-${scope}`,
				mod: "tracing-collector",
				svc: "tracing-collector",
			});

			// Expect trace ids to be equal and span ids to be different
			expect(log1.dd.trace_id).toEqual(log1.dd.span_id);
			expect(log1.dd.trace_id).toEqual(log2.dd.trace_id);
			expect(log1.dd.span_id).not.toEqual(log2.dd.span_id);
		});

		it("uses an external span as a parent", async () => {
			const ddTracer = broker.tracer.exporter[0].ddTracer;

			const [result, spanContext] = await ddTracer.trace(
				"test-external",
				async (span) => {
					const r = await broker.call(
						"tracing-collector.getSpan",
						{}
					);
					return [r, span.context()];
				}
			);

			expect(result).not.toBeNull();
			expect(result).toHaveProperty("traceId", spanContext.toTraceId());
			expect(result).toHaveProperty("parentId", spanContext.toSpanId());
		});

		it("works with custom spans in action handler", async () => {
			const ddTracer = broker.tracer.exporter[0].ddTracer;
			let span = ddTracer.scope().active();
			expect(span).toBeNull();

			const spans = await broker.call("tracing-collector.customSpans");

			// spans == [action, span1, span2, span1, span3, action]
			expect(spans).toHaveLength(6);

			// expect all the spans to be part of the same trace
			expect(_.uniq(spans.map((s) => s.traceId))).toHaveLength(1);

			// expect correct names and parent ids
			expect(spans[0]).toHaveProperty(
				"name",
				"action 'tracing-collector.customSpans'"
			);
			expect(spans[0]).toEqual(spans[5]);
			expect(spans[0]).toHaveProperty("parentId", null);

			expect(spans[1]).toHaveProperty("name", "span1");
			expect(spans[1]).toEqual(spans[3]);
			expect(spans[1]).toHaveProperty("parentId", spans[0].spanId);

			expect(spans[2]).toHaveProperty("name", "span2");
			expect(spans[2]).toHaveProperty("parentId", spans[1].spanId);

			expect(spans[4]).toHaveProperty("name", "span3");
			expect(spans[4]).toHaveProperty("parentId", spans[0].spanId);
		});

		it("works with event handlers", async () => {
			await broker.call("tracing-collector.triggerEvent");

			// Filter out objects from the event exporter
			const spans = STORE.filter((item) => !item.id);

			// spans = [action, event, custom, custom, event]
			expect(spans).toHaveLength(5);

			// expect all the spans to be part of the same trace
			expect(_.uniq(spans.map((s) => s.traceId))).toHaveLength(1);

			// expect correct names and parent ids
			expect(spans[0]).toHaveProperty(
				"name",
				"action 'tracing-collector.triggerEvent'"
			);
			expect(spans[0]).toHaveProperty("parentId", null);

			expect(spans[1]).toHaveProperty(
				"name",
				"event 'some.event' in 'tracing-collector'"
			);
			expect(spans[1]).toEqual(spans[4]);
			expect(spans[1]).toHaveProperty("parentId", spans[0].spanId);

			expect(spans[2]).toHaveProperty("name", "custom span");
			expect(spans[2]).toEqual(spans[3]);
			expect(spans[2]).toHaveProperty("parentId", spans[1].spanId);
		});
	});
});
