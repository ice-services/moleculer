const ServiceBroker 			= require("../../../src/service-broker");
const { MoleculerError }		= require("../../../src/errors");
const Middleware 				= require("../../../src/middlewares").Tracing;
const { protectReject }			= require("../utils");

describe("Test TracingMiddleware localAction", () => {

	describe("Test localAction wrapping", () => {
		const broker = new ServiceBroker({ nodeID: "server-1", logger: false });
		const handler = jest.fn(() => Promise.resolve("Result"));
		const action = {
			name: "posts.find",
			handler
		};

		it("should not register hooks if tracing is disabled", () => {
			const mw = Middleware(broker);

			expect(mw.name).toBe("Tracing");
			expect(mw.localAction).toBeNull();
		});

		it("should wrap handler if tracing is enabled", () => {
			broker.options.tracing.enabled = true;
			broker.tracer.opts.enabled = true;

			const mw = Middleware(broker);
			expect(mw.localAction).toBeInstanceOf(Function);

			const newHandler = mw.localAction.call(broker, handler, action);
			expect(newHandler).not.toBe(handler);
		});

		it("should not wrap handler if tracing is disabled in action definition", () => {
			action.tracing = false;

			const mw = Middleware(broker);
			expect(mw.localAction).toBeInstanceOf(Function);

			const newHandler = mw.localAction.call(broker, handler, action);
			expect(newHandler).toBe(handler);
		});

		it("should not wrap handler if tracing is disabled in action definition", () => {
			action.tracing = { enabled: false };

			const mw = Middleware(broker);
			expect(mw.localAction).toBeInstanceOf(Function);

			const newHandler = mw.localAction.call(broker, handler, action);
			expect(newHandler).toBe(handler);
		});

		it("should wrap handler if tracing is enabled in action definition", () => {
			action.tracing = true;

			const mw = Middleware(broker);
			expect(mw.localAction).toBeInstanceOf(Function);

			const newHandler = mw.localAction.call(broker, handler, action);
			expect(newHandler).not.toBe(handler);
		});

		it("should wrap handler if tracing is enabled in action definition", () => {
			action.tracing = { enabled: true };

			const mw = Middleware(broker);
			expect(mw.localAction).toBeInstanceOf(Function);

			const newHandler = mw.localAction.call(broker, handler, action);
			expect(newHandler).not.toBe(handler);
		});

	});

	describe("Test localAction handler", () => {
		const broker = new ServiceBroker({ nodeID: "server-1", logger: false, tracing: true });
		const result = {
			id: "post-id",
			title: "Post title",
			content: "Post content"
		};

		const handler = jest.fn(() => Promise.resolve(result));
		const action = {
			name: "posts.find",
			rawName: "find",
			handler
		};

		const tracer = broker.tracer;
		tracer.getCurrentTraceID = jest.fn();
		tracer.getActiveSpanID = jest.fn();

		const fakeSpan = {
			addTags: jest.fn(()=> fakeSpan),
			setError: jest.fn(() => fakeSpan),
			finish: jest.fn(),
			sampled: true
		};

		const ctx = {
			broker,
			action,
			id: "ctx-id",
			requestID: "request-id",
			traceID: "trace-id",
			parentID: "parent-id",
			level: 3,
			service: {
				name: "posts",
				version: 1,
				fullName: "v1.posts"
			},
			tracing: true,
			cachedResult: false,
			nodeID: "server-2",
			options: {
				timeout: 5,
				retries: 3
			},

			params: {
				a: 2,
				b: "John",
				c: {
					d: 100,
					e: true
				}
			},

			meta: {
				user: {
					name: "Adam",
					age: 30
				}
			},

			startSpan: jest.fn(() => fakeSpan),
			finishSpan: jest.fn()
		};

		it("should create a span", async () => {
			const mw = Middleware(broker);
			const newHandler = mw.localAction.call(broker, handler, action);

			tracer.getCurrentTraceID.mockClear();
			tracer.getActiveSpanID.mockClear();
			ctx.startSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			const res = await newHandler(ctx);

			expect(res).toBe(result);

			/* eslint-disable-next-line */
			ctx.params.a = 5;

			expect(tracer.getCurrentTraceID).toHaveBeenCalledTimes(0);
			expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(0);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'", {
				id: "ctx-id",
				type: "action",
				traceID: "trace-id",
				parentID: "parent-id",
				service: {
					fullName: "v1.posts",
					name: "posts",
					version: 1
				},
				tags: {
					action: {
						name: "posts.find",
						rawName: "find"
					},
					callerNodeID: "server-2",
					callingLevel: 3,
					nodeID: "server-1",
					options: {
						retries: 3,
						timeout: 5
					},
					requestID: "request-id",
					remoteCall: true,

					params: {
						a: 2,
						b: "John",
						c: {
							d: 100,
							e: true
						}
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			expect(ctx.tracing).toBe(true);

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
			expect(fakeSpan.addTags).toHaveBeenCalledWith({ fromCache: false });

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span with context tags & without service", async () => {
			action.tracing = {
				spanName: "static text",
				tags: {
					params: ["a", "c"],
					meta: ["user.name"],
					response: ["id", "title"]
				}
			};

			ctx.service = null;
			ctx.nodeID = "server-1";

			tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
			tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

			const mw = Middleware(broker);
			const newHandler = mw.localAction.call(broker, handler, action);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			const res = await newHandler(ctx);

			expect(res).toBe(result);

			expect(tracer.getCurrentTraceID).toHaveBeenCalledTimes(0);
			expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(0);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("static text", {
				id: "ctx-id",
				type: "action",
				traceID: "trace-id",
				parentID: "parent-id",
				service: null,
				tags: {
					action: {
						name: "posts.find",
						rawName: "find"
					},
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					options: {
						retries: 3,
						timeout: 5
					},
					requestID: "request-id",
					remoteCall: false,

					params: {
						a: 5,
						c:{
							d: 100,
							e: true
						}
					},

					meta: {
						user: {
							name: "Adam"
						}
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			expect(ctx.tracing).toBe(true);

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
			expect(fakeSpan.addTags).toHaveBeenCalledWith({
				fromCache: false,
				response: {
					id: "post-id",
					title: "Post title"
				}
			});

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span with cloned params & meta", async () => {
			action.tracing = {
				spanName: ctx => `The ${ctx.action.name} action called`,
				tags: {
					params: true,
					meta: true,
					response: true
				}
			};

			const mw = Middleware(broker);
			const newHandler = mw.localAction.call(broker, handler, action);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			/* eslint-disable-next-line */
			ctx.params.a = 10;
			/* eslint-disable-next-line */
			ctx.meta.user.age = 35;

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("The posts.find action called", {
				id: "ctx-id",
				type: "action",
				traceID: "trace-id",
				parentID: "parent-id",
				service: null,
				tags: {
					action: {
						name: "posts.find",
						rawName: "find"
					},
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					options: {
						retries: 3,
						timeout: 5
					},
					requestID: "request-id",
					remoteCall: false,

					meta: {
						user: {
							age: 35,
							name: "Adam"
						}
					},
					params: {
						a: 5,
						b: "John",
						c: {
							d: 100,
							e: true
						}
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
			expect(fakeSpan.addTags).toHaveBeenCalledWith({
				fromCache: false,
				response: result
			});

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span without params, meta & response", async () => {
			action.tracing = {
				tags: {
					params: false,
					meta: false,
					response: false
				}
			};

			const mw = Middleware(broker);
			const newHandler = mw.localAction.call(broker, handler, action);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'", {
				id: "ctx-id",
				type: "action",
				traceID: "trace-id",
				parentID: "parent-id",
				service: null,
				tags: {
					action: {
						name: "posts.find",
						rawName: "find"
					},
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					options: {
						retries: 3,
						timeout: 5
					},
					requestID: "request-id",
					remoteCall: false
				},
				sampled: true,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
			expect(fakeSpan.addTags).toHaveBeenCalledWith({
				fromCache: false
			});

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span without params, meta & response", async () => {
			action.tracing = {
				tags: jest.fn((ctx, response) => ({
					custom: {
						params: ctx.params,
						meta: ctx.meta,
						response
					}
				}))
			};

			const mw = Middleware(broker);
			const newHandler = mw.localAction.call(broker, handler, action);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'", {
				id: "ctx-id",
				type: "action",
				traceID: "trace-id",
				parentID: "parent-id",
				service: null,
				tags: {
					action: {
						name: "posts.find",
						rawName: "find"
					},
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					options: {
						retries: 3,
						timeout: 5
					},
					requestID: "request-id",
					remoteCall: false,
					custom: {
						meta: {
							user: {
								age: 35,
								name: "Adam"
							}
						},
						params: {
							a: 10,
							b: "John",
							c: {
								d: 100,
								e: true
							}
						},
						response: undefined
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
			expect(fakeSpan.addTags).toHaveBeenCalledWith({
				fromCache: false,
				custom: {
					meta: {
						user: {
							age: 35,
							name: "Adam"
						}
					},
					params: {
						a: 10,
						b: "John",
						c: {
							d: 100,
							e: true
						}
					},
					response: {
						id: "post-id",
						title: "Post title",
						content: "Post content"
					}
				}
			});

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span with custom tags function & error", () => {
			const error = new MoleculerError("Something happened", 456, "SOMETHING", { some: "thing" });
			action.handler = jest.fn(() => Promise.reject(error));
			action.tracing = {
				tags: jest.fn((ctx, response) => ({
					custom: {
						params: ctx.params,
						meta: ctx.meta,
						response
					}
				}))
			};

			fakeSpan.sampled = false;

			ctx.requestID = null;
			ctx.traceID = null;
			ctx.parentID = null;

			tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
			tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

			const mw = Middleware(broker);
			const newHandler = mw.localAction.call(broker, action.handler, action);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			return newHandler(ctx).then(protectReject).catch(err => {
				expect(err).toBe(error);

				expect(action.handler).toHaveBeenCalledTimes(1);

				expect(action.tracing.tags).toHaveBeenCalledTimes(1);
				expect(action.tracing.tags).toHaveBeenCalledWith(ctx);

				expect(tracer.getCurrentTraceID).toHaveBeenCalledTimes(2);
				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'", {
					id: "ctx-id",
					type: "action",
					traceID: "tracer-trace-id",
					parentID: "tracer-span-id",
					service: null,
					tags: {
						action: {
							name: "posts.find",
							rawName: "find"
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						nodeID: "server-1",
						options: {
							retries: 3,
							timeout: 5
						},
						requestID: "tracer-trace-id",
						remoteCall: false,

						custom: {
							meta: {
								user: {
									age: 35,
									name: "Adam"
								}
							},
							params: {
								a: 10,
								b: "John",
								c: {
									d: 100,
									e: true
								}
							}
						}
					},
					sampled: true,
					autoActivate: false
				});

				expect(ctx.tracing).toBe(false);

				expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

				expect(fakeSpan.setError).toHaveBeenCalledTimes(1);
				expect(fakeSpan.setError).toHaveBeenCalledWith(err);
			});

		});

		it("should create a span with non-object params & response", async () => {
			action.tracing = {
				tags: {
					params: true,
					response: true
				}
			};

			const mw = Middleware(broker);
			const newHandler = mw.localAction.call(broker, handler, action);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			ctx.params = "Moleculer";

			await newHandler(ctx);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'", {
				id: "ctx-id",
				type: "action",
				traceID: "tracer-trace-id",
				parentID: "tracer-span-id",
				service: null,
				tags: {
					action: {
						name: "posts.find",
						rawName: "find"
					},
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					options: {
						retries: 3,
						timeout: 5
					},
					requestID: "tracer-trace-id",
					remoteCall: false,

					params: "Moleculer"
				},
				sampled: false,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
			expect(fakeSpan.addTags).toHaveBeenCalledWith({
				fromCache: false,
				response: result
			});

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
		});

		describe("global action tags", () => {
			let action;
			beforeEach(() => {
				handler.mockClear();
				ctx.startSpan.mockClear();
				ctx.finishSpan.mockClear();
				fakeSpan.addTags.mockClear();
				fakeSpan.setError.mockClear();
				fakeSpan.finish.mockClear();
				ctx.tracing = true;
				ctx.requestID = "request-id";

				action = {
					name: "posts.find",
					rawName: "find",
					handler
				};
				ctx.params = {
					a: 2,
					b: "John",
					c: {
						d: 100,
						e: true
					}
				},
				ctx.meta = {
					user: {
						name: "Adam",
						age: 30
					}
				};
			});

			it("should create a span with local custom tags function even if global custom tags are specified", async () => {
				const brokerOptions = {
					tracing: {
						tags: {
							action: jest.fn((ctx, response) => {})
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, tracing: true, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();
				action.tracing = {
					tags: jest.fn((ctx, response) => ({
						custom: {
							params: ctx.params,
							meta: ctx.meta,
							response
						}
					}))
				};

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localAction.call(broker, action.handler, action);

				await newHandler(ctx);
				expect(action.handler).toHaveBeenCalledTimes(1);

				// params/meta and response
				expect(action.tracing.tags).toHaveBeenCalledTimes(2);
				expect(action.tracing.tags).toHaveBeenCalledWith(ctx);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: null,
					tags: {
						action: {
							name: "posts.find",
							rawName: "find"
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						custom: {
							meta: {
								user: { age: 30, name: "Adam" }
							},
							params: {
								a: 2,
								b: "John",
								c: {
									d: 100,
									e: true
								},
							},
							response: undefined
						},
						nodeID: "server-1",
						options: {
							retries: 3,
							timeout: 5
						},
						requestID: "request-id",
						remoteCall: false
					},
					traceID: "tracer-trace-id",
					type: "action",
					autoActivate: false
				});

				expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
				expect(brokerOptions.tracing.tags.action).toHaveBeenCalledTimes(0);
			});

			it("should create a span with global custom tags function if no local action tags are specified", async () => {
				const brokerOptions = {
					tracing: {
						tags: {
							action: jest.fn((ctx, response) => ({
								custom: {
									params: ctx.params,
									meta: ctx.meta,
									response
								}
							}))
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, tracing: true, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();
				fakeSpan.sampled = false;

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localAction.call(broker, action.handler, action);

				await newHandler(ctx);
				expect(action.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: null,
					tags: {
						action: {
							name: "posts.find",
							rawName: "find"
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						custom: {
							meta: {
								user: { age: 30, name: "Adam" }
							},
							params: {
								a: 2,
								b: "John",
								c: {
									d: 100,
									e: true
								},
							},
							response: undefined
						},
						nodeID: "server-1",
						options: {
							retries: 3,
							timeout: 5
						},
						requestID: "request-id",
						remoteCall: false
					},
					traceID: "tracer-trace-id",
					type: "action",
					autoActivate: false

				});
				expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
				expect(brokerOptions.tracing.tags.action).toHaveBeenCalledTimes(2);
				expect(brokerOptions.tracing.tags.action).toHaveBeenCalledWith(ctx);
			});

			it("should default to params tags if no local or global action tags are specified", async () => {
				const brokerOptions = {};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, tracing: true, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();
				fakeSpan.sampled = false;

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localAction.call(broker, action.handler, action);

				await newHandler(ctx);
				expect(action.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: null,
					tags: {
						action: {
							name: "posts.find",
							rawName: "find"
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						params: {
							a: 2,
							b: "John",
							c: {
								d: 100,
								e: true
							},
						},
						nodeID: "server-1",
						options: {
							retries: 3,
							timeout: 5
						},
						requestID: "request-id",
						remoteCall: false
					},
					traceID: "tracer-trace-id",
					type: "action",
					autoActivate: false
				});

				expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			});

			it("should merge global action tags with the default params tag", async () => {
				const brokerOptions = {
					tracing: {
						tags: {
							action: {
								meta: true,
								response: true,
							}
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, tracing: true, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();
				fakeSpan.sampled = false;

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localAction.call(broker, action.handler, action);

				await newHandler(ctx);
				expect(action.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: null,
					tags: {
						action: {
							name: "posts.find",
							rawName: "find"
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						meta: {
							user: { age: 30, name: "Adam" }
						},
						params: {
							a: 2,
							b: "John",
							c: {
								d: 100,
								e: true
							},
						},
						nodeID: "server-1",
						options: {
							retries: 3,
							timeout: 5
						},
						requestID: "request-id",
						remoteCall: false
					},
					traceID: "tracer-trace-id",
					type: "action",
					autoActivate: false
				});

				expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
				expect(fakeSpan.addTags).toHaveBeenCalledWith({
					fromCache: false,
					response: {
						id: "post-id",
						title: "Post title",
						content: "Post content",
					},
				});

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			});

			it("should override global action tags with local tags", async () => {
				const brokerOptions = {
					tracing: {
						tags: {
							action: {
								params: false,
								meta: false,
								response: false,
							}
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, tracing: true, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();
				fakeSpan.sampled = false;

				action.tracing = {
					tags: {
						params: ["a"],
						meta: ["user.age"],
						response: ["id"],
					}
				};

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localAction.call(broker, action.handler, action);

				await newHandler(ctx);
				expect(action.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("action 'posts.find'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: null,
					tags: {
						action: {
							name: "posts.find",
							rawName: "find"
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						meta: {
							user: { age: 30 }
						},
						params: {
							a: 2,
						},
						nodeID: "server-1",
						options: {
							retries: 3,
							timeout: 5
						},
						requestID: "request-id",
						remoteCall: false
					},
					traceID: "tracer-trace-id",
					type: "action",
					autoActivate: false
				});

				expect(fakeSpan.addTags).toHaveBeenCalledTimes(1);
				expect(fakeSpan.addTags).toHaveBeenCalledWith({
					fromCache: false,
					response: {
						id: "post-id",
					},
				});

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			});
		});

	});

});

describe("Test TracingMiddleware localEvent", () => {

	describe("Test localEvent wrapping", () => {
		const broker = new ServiceBroker({ nodeID: "server-1", logger: false });
		const handler = jest.fn(() => Promise.resolve("Result"));
		const event = {
			name: "posts.find",
			handler
		};

		it("should not register hooks if tracing is disabled", () => {
			const mw = Middleware(broker);

			expect(mw.name).toBe("Tracing");
			expect(mw.localEvent).toBeNull();
		});

		it("should wrap handler if tracing is enabled", () => {
			broker.options.tracing.enabled = true;
			broker.tracer.opts.enabled = true;
			broker.tracer.opts.events = true;

			const mw = Middleware(broker);
			expect(mw.localEvent).toBeInstanceOf(Function);

			const newHandler = mw.localEvent.call(broker, handler, event);
			expect(newHandler).not.toBe(handler);
		});

		it("should not wrap handler if tracing is disabled in event definition", () => {
			event.tracing = false;

			const mw = Middleware(broker);
			expect(mw.localEvent).toBeInstanceOf(Function);

			const newHandler = mw.localEvent.call(broker, handler, event);
			expect(newHandler).toBe(handler);
		});

		it("should not wrap handler if tracing is disabled in event definition", () => {
			event.tracing = { enabled: false };

			const mw = Middleware(broker);
			expect(mw.localEvent).toBeInstanceOf(Function);

			const newHandler = mw.localEvent.call(broker, handler, event);
			expect(newHandler).toBe(handler);
		});

		it("should wrap handler if tracing is enabled in event definition", () => {
			event.tracing = true;

			const mw = Middleware(broker);
			expect(mw.localEvent).toBeInstanceOf(Function);

			const newHandler = mw.localEvent.call(broker, handler, event);
			expect(newHandler).not.toBe(handler);
		});

		it("should wrap handler if tracing is enabled in event definition", () => {
			event.tracing = { enabled: true };

			const mw = Middleware(broker);
			expect(mw.localEvent).toBeInstanceOf(Function);

			const newHandler = mw.localEvent.call(broker, handler, event);
			expect(newHandler).not.toBe(handler);
		});

	});

	describe("Test localEvent handler", () => {
		const broker = new ServiceBroker({ nodeID: "server-1", logger: false, tracing: {
			enabled: true,
			events: true
		} });

		const handler = jest.fn(() => Promise.resolve());
		const event = {
			name: "user.created",
			group: "posts",
			service: {
				name: "posts",
				version: 1,
				fullName: "v1.posts"
			},
			handler
		};

		const tracer = broker.tracer;
		tracer.getCurrentTraceID = jest.fn();
		tracer.getActiveSpanID = jest.fn();

		const fakeSpan = {
			addTags: jest.fn(()=> fakeSpan),
			setError: jest.fn(() => fakeSpan),
			finish: jest.fn(),
			sampled: true
		};

		const ctx = {
			broker,
			event,
			id: "ctx-id",
			requestID: "request-id",
			traceID: "trace-id",
			parentID: "parent-id",
			eventName: "user.created",
			eventType: "emit",
			eventGroup: "posts",
			level: 3,
			service: {
				name: "posts",
				version: 1,
				fullName: "v1.posts"
			},
			tracing: true,
			cachedResult: false,
			nodeID: "server-2",
			options: {},

			params: {
				a: 2,
				b: "John",
				c: {
					d: 100,
					e: true
				}
			},

			meta: {
				user: {
					name: "Adam",
					age: 30
				}
			},

			startSpan: jest.fn(() => fakeSpan),
			finishSpan: jest.fn()
		};

		it("should create a span", async () => {
			const mw = Middleware(broker);
			const newHandler = mw.localEvent.call(broker, handler, event);

			tracer.getCurrentTraceID.mockClear();
			tracer.getActiveSpanID.mockClear();
			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			/* eslint-disable-next-line */
			ctx.params.a = 5;

			expect(tracer.getCurrentTraceID).toHaveBeenCalledTimes(0);
			expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(0);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'", {
				id: "ctx-id",
				type: "event",
				traceID: "trace-id",
				parentID: "parent-id",
				service: {
					fullName: "v1.posts",
					name: "posts",
					version: 1
				},
				tags: {
					event: {
						name: "user.created",
						group: "posts"
					},
					eventName: "user.created",
					eventType: "emit",
					callerNodeID: "server-2",
					callingLevel: 3,
					nodeID: "server-1",
					remoteCall: true,
					requestID: "request-id",

					params: {
						a: 2,
						b: "John",
						c: {
							d: 100,
							e: true
						}
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(ctx.span).toBeUndefined();
			expect(ctx.tracing).toBe(true);

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span with context tags & without service", async () => {
			event.tracing = {
				spanName: "static text",
				tags: {
					params: ["a", "c"],
					meta: ["user.name"]
				}
			};

			ctx.service = null;
			ctx.nodeID = "server-1";

			tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
			tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

			const mw = Middleware(broker);
			const newHandler = mw.localEvent.call(broker, handler, event);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			expect(tracer.getCurrentTraceID).toHaveBeenCalledTimes(0);
			expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(0);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("static text", {
				id: "ctx-id",
				type: "event",
				traceID: "trace-id",
				parentID: "parent-id",
				service: {
					fullName: "v1.posts",
					name: "posts",
					version: 1
				},
				tags: {
					event: {
						name: "user.created",
						group: "posts"
					},
					eventName: "user.created",
					eventType: "emit",
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					remoteCall: false,
					requestID: "request-id",

					params: {
						a: 5,
						c:{
							d: 100,
							e: true
						}
					},

					meta: {
						user: {
							name: "Adam"
						}
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(ctx.span).toBeUndefined();
			expect(ctx.tracing).toBe(true);

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span with cloned params & meta", async () => {
			event.tracing = {
				spanName: ctx => `The ${ctx.eventName} triggered`,
				tags: {
					params: true,
					meta: true
				}
			};

			const mw = Middleware(broker);
			const newHandler = mw.localEvent.call(broker, handler, event);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			// eslint-disable-next-line
			ctx.params.a = 10;
			// eslint-disable-next-line
			ctx.meta.user.age = 35;

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("The user.created triggered", {
				id: "ctx-id",
				type: "event",
				traceID: "trace-id",
				parentID: "parent-id",
				service: {
					fullName: "v1.posts",
					name: "posts",
					version: 1
				},
				tags: {
					event: {
						name: "user.created",
						group: "posts"
					},
					eventName: "user.created",
					eventType: "emit",
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					remoteCall: false,
					requestID: "request-id",

					meta: {
						user: {
							age: 35,
							name: "Adam"
						}
					},
					params: {
						a: 5,
						b: "John",
						c: {
							d: 100,
							e: true
						}
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span without params, meta", async () => {
			event.tracing = {
				tags: {
					params: false,
					meta: false
				}
			};

			const mw = Middleware(broker);
			const newHandler = mw.localEvent.call(broker, handler, event);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'", {
				id: "ctx-id",
				type: "event",
				traceID: "trace-id",
				parentID: "parent-id",
				service: {
					fullName: "v1.posts",
					name: "posts",
					version: 1
				},
				tags: {
					event: {
						name: "user.created",
						group: "posts"
					},
					eventName: "user.created",
					eventType: "emit",
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					remoteCall: false,
					requestID: "request-id",
				},
				sampled: true,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span without params, meta & response", async () => {
			event.tracing = {
				tags: jest.fn((ctx, response) => ({
					custom: {
						params: ctx.params,
						meta: ctx.meta,
						response
					}
				}))
			};

			const mw = Middleware(broker);
			const newHandler = mw.localEvent.call(broker, handler, event);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			await newHandler(ctx);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'", {
				id: "ctx-id",
				type: "event",
				traceID: "trace-id",
				parentID: "parent-id",
				service: {
					fullName: "v1.posts",
					name: "posts",
					version: 1
				},
				tags: {
					event: {
						name: "user.created",
						group: "posts"
					},
					eventName: "user.created",
					eventType: "emit",
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					remoteCall: false,
					requestID: "request-id",

					custom: {
						meta: {
							user: {
								age: 35,
								name: "Adam"
							}
						},
						params: {
							a: 10,
							b: "John",
							c: {
								d: 100,
								e: true
							}
						},
						response: undefined
					}
				},
				sampled: true,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		it("should create a span with custom tags function & error", () => {
			const error = new MoleculerError("Something happened", 456, "SOMETHING", { some: "thing" });
			event.handler = jest.fn(() => Promise.reject(error));
			event.tracing = {
				tags: jest.fn(ctx => ({
					custom: {
						params: ctx.params,
						meta: ctx.meta
					}
				}))
			};

			fakeSpan.sampled = false;

			ctx.requestID = null;
			ctx.traceID = null;
			ctx.parentID = null;

			tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
			tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

			const mw = Middleware(broker);
			const newHandler = mw.localEvent.call(broker, event.handler, event);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			return newHandler(ctx).then(protectReject).catch(err => {
				expect(err).toBe(error);

				expect(event.handler).toHaveBeenCalledTimes(1);

				expect(event.tracing.tags).toHaveBeenCalledTimes(1);
				expect(event.tracing.tags).toHaveBeenCalledWith(ctx);

				expect(tracer.getCurrentTraceID).toHaveBeenCalledTimes(2);
				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'", {
					id: "ctx-id",
					type: "event",
					traceID: "tracer-trace-id",
					parentID: "tracer-span-id",
					service: {
						fullName: "v1.posts",
						name: "posts",
						version: 1
					},
					tags: {
						event: {
							name: "user.created",
							group: "posts"
						},
						eventName: "user.created",
						eventType: "emit",
						callerNodeID: "server-1",
						callingLevel: 3,
						nodeID: "server-1",
						remoteCall: false,
						requestID: "tracer-trace-id",

						custom: {
							meta: {
								user: {
									age: 35,
									name: "Adam"
								}
							},
							params: {
								a: 10,
								b: "John",
								c: {
									d: 100,
									e: true
								}
							}
						}
					},
					sampled: true,
					autoActivate: false
				});

				expect(ctx.span).toBeUndefined();
				expect(ctx.tracing).toBe(false);

				expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

				expect(fakeSpan.setError).toHaveBeenCalledTimes(1);
				expect(fakeSpan.setError).toHaveBeenCalledWith(err);
			});

		});

		it("should create a span with non-object params", async () => {
			event.tracing = {
				tags: {
					params: true
				}
			};

			const mw = Middleware(broker);
			const newHandler = mw.localEvent.call(broker, handler, event);

			ctx.startSpan.mockClear();
			ctx.finishSpan.mockClear();
			fakeSpan.addTags.mockClear();
			fakeSpan.setError.mockClear();
			fakeSpan.finish.mockClear();

			ctx.params = "Moleculer";

			await newHandler(ctx);

			expect(ctx.startSpan).toHaveBeenCalledTimes(1);
			expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'", {
				id: "ctx-id",
				type: "event",
				traceID: "tracer-trace-id",
				parentID: "tracer-span-id",
				service: {
					fullName: "v1.posts",
					name: "posts",
					version: 1
				},
				tags: {
					event: {
						name: "user.created",
						group: "posts"
					},
					eventName: "user.created",
					eventType: "emit",
					callerNodeID: "server-1",
					callingLevel: 3,
					nodeID: "server-1",
					remoteCall: false,
					requestID: "tracer-trace-id",

					params: "Moleculer"
				},
				sampled: false,
				autoActivate: false
			});

			expect(fakeSpan.addTags).toHaveBeenCalledTimes(0);

			expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
			expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);

			expect(fakeSpan.setError).toHaveBeenCalledTimes(0);
		});

		describe("global event tags", () => {
			let event;
			beforeEach(() => {
				handler.mockClear();
				ctx.startSpan.mockClear();
				ctx.finishSpan.mockClear();
				fakeSpan.addTags.mockClear();
				fakeSpan.setError.mockClear();
				fakeSpan.finish.mockClear();
				fakeSpan.sampled = true;
				ctx.requestID = "request-id";

				event = {
					name: "user.created",
					group: "posts",
					service: {
						name: "posts",
						version: 1,
						fullName: "v1.posts"
					},
					handler
				};
				ctx.tracing = true;
				ctx.params = {
					a: 2,
					b: "John",
					c: {
						d: 100,
						e: true
					}
				},
				ctx.meta = {
					user: {
						name: "Adam",
						age: 30
					}
				};
			});


			it("should create a span with local custom tags function even if global custom event tags are specified", async () => {
				const brokerOptions = {
					tracing: {
						enabled: true,
						events: true,
						tags: {
							event: jest.fn((ctx, response) => {})
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();
				event.tracing = {
					tags: jest.fn((ctx, response) => ({
						custom: {
							params: ctx.params,
							meta: ctx.meta,
							response
						}
					}))
				};

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localEvent.call(broker, event.handler, event);

				await newHandler(ctx);
				expect(event.handler).toHaveBeenCalledTimes(1);

				expect(event.tracing.tags).toHaveBeenCalledTimes(1);
				expect(event.tracing.tags).toHaveBeenCalledWith(ctx);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: {
						fullName: "v1.posts",
						name: "posts",
						version: 1
					},
					tags: {
						event: {
							group: "posts",
							name: "user.created",
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						custom: {
							meta: {
								user: { age: 30, name: "Adam" }
							},
							params: {
								a: 2,
								b: "John",
								c: {
									d: 100,
									e: true
								},
							},
						},
						eventName: "user.created",
						eventType: "emit",
						nodeID: "server-1",
						remoteCall: false,
						requestID: "request-id",
					},
					traceID: "tracer-trace-id",
					type: "event",
					autoActivate: false
				});

				expect(ctx.tracing).toBe(true);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
				expect(brokerOptions.tracing.tags.event).toHaveBeenCalledTimes(0);
			});

			it("should create a span with global custom tags function if no local event tags are specified", async () => {
				const brokerOptions = {
					tracing: {
						enabled: true,
						events: true,
						tags: {
							event: jest.fn((ctx, response) => ({
								custom: {
									params: ctx.params,
									meta: ctx.meta,
								}
							}))
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localEvent.call(broker, event.handler, event);

				await newHandler(ctx);
				expect(event.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: {
						fullName: "v1.posts",
						name: "posts",
						version: 1
					},
					tags: {
						event: {
							group: "posts",
							name: "user.created",
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						custom: {
							meta: {
								user: { age: 30, name: "Adam" }
							},
							params: {
								a: 2,
								b: "John",
								c: {
									d: 100,
									e: true
								},
							},
						},
						eventName: "user.created",
						eventType: "emit",
						nodeID: "server-1",
						remoteCall: false,
						requestID: "request-id",
					},
					traceID: "tracer-trace-id",
					type: "event",
					autoActivate: false

				});
				expect(ctx.tracing).toBe(true);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
				expect(brokerOptions.tracing.tags.event).toHaveBeenCalledTimes(1);
				expect(brokerOptions.tracing.tags.event).toHaveBeenCalledWith(ctx);
			});

			it("should default to params tags if no local or global event tags are specified", async () => {
				const brokerOptions = {
					tracing: {
						enabled: true,
						events: true,
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localEvent.call(broker, event.handler, event);

				ctx.startSpan.mockClear();
				ctx.finishSpan.mockClear();
				fakeSpan.addTags.mockClear();
				fakeSpan.setError.mockClear();
				fakeSpan.finish.mockClear();

				await newHandler(ctx);
				expect(event.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: {
						fullName: "v1.posts",
						name: "posts",
						version: 1
					},
					tags: {
						event: {
							group: "posts",
							name: "user.created",
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						params: {
							a: 2,
							b: "John",
							c: {
								d: 100,
								e: true
							},
						},
						eventName: "user.created",
						eventType: "emit",
						nodeID: "server-1",
						remoteCall: false,
						requestID: "request-id",
					},
					traceID: "tracer-trace-id",
					type: "event",
					autoActivate: false
				});
				expect(ctx.tracing).toBe(true);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			});

			it("should merge global event tags with the default params tag", async () => {
				const brokerOptions = {
					tracing: {
						enabled: true,
						events: true,
						tags: {
							event: {
								meta: true,
							}
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localEvent.call(broker, event.handler, event);

				ctx.startSpan.mockClear();
				ctx.finishSpan.mockClear();
				fakeSpan.addTags.mockClear();
				fakeSpan.setError.mockClear();
				fakeSpan.finish.mockClear();

				await newHandler(ctx);
				expect(event.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: {
						fullName: "v1.posts",
						name: "posts",
						version: 1,
					},
					tags: {
						event: {
							group: "posts",
							name: "user.created",
						},
						eventName: "user.created",
						eventType: "emit",
						nodeID: "server-1",
						callerNodeID: "server-1",
						callingLevel: 3,
						meta: {
							user: { age: 30, name: "Adam" }
						},
						params: {
							a: 2,
							b: "John",
							c: {
								d: 100,
								e: true
							},
						},
						remoteCall: false,
						requestID: "request-id",
					},
					traceID: "tracer-trace-id",
					type: "event",
					autoActivate: false
				});
				expect(ctx.tracing).toBe(true);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			});

			it("should override global event tags with local tags", async () => {
				const brokerOptions = {
					tracing: {
						enabled: true,
						events: true,
						tags: {
							event: {
								params: false,
								meta: false,
							}
						}
					}
				};
				const broker = new ServiceBroker({ nodeID: "server-1", logger: false, ...brokerOptions });
				const tracer = broker.tracer;
				tracer.getCurrentTraceID = jest.fn();
				tracer.getActiveSpanID = jest.fn();

				event.tracing = {
					tags: {
						params: ["a"],
						meta: ["user.age"],
					}
				};

				ctx.parentID = null;
				ctx.traceID = null;

				tracer.getCurrentTraceID = jest.fn(() => "tracer-trace-id");
				tracer.getActiveSpanID = jest.fn(() => "tracer-span-id");

				const mw = Middleware(broker);
				const newHandler = mw.localEvent.call(broker, event.handler, event);

				ctx.startSpan.mockClear();
				ctx.finishSpan.mockClear();
				fakeSpan.addTags.mockClear();
				fakeSpan.setError.mockClear();
				fakeSpan.finish.mockClear();

				await newHandler(ctx);
				expect(event.handler).toHaveBeenCalledTimes(1);

				expect(tracer.getActiveSpanID).toHaveBeenCalledTimes(1);

				expect(ctx.startSpan).toHaveBeenCalledTimes(1);
				expect(ctx.startSpan).toHaveBeenCalledWith("event 'user.created' in 'v1.posts'",{
					id: "ctx-id",
					parentID: "tracer-span-id",
					sampled: true,
					service: {
						fullName: "v1.posts",
						name: "posts",
						version: 1
					},
					tags: {
						eventName: "user.created",
						eventType: "emit",
						event: {
							group: "posts",
							name: "user.created",
						},
						callerNodeID: "server-1",
						callingLevel: 3,
						meta: {
							user: { age: 30 }
						},
						params: {
							a: 2,
						},
						nodeID: "server-1",
						remoteCall: false,
						requestID: "request-id",
					},
					traceID: "tracer-trace-id",
					type: "event",
					autoActivate: false
				});
				expect(ctx.tracing).toBe(true);

				expect(ctx.finishSpan).toHaveBeenCalledTimes(1);
				expect(ctx.finishSpan).toHaveBeenCalledWith(fakeSpan);
			});
		});
	});
});
