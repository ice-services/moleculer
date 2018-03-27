"use strict";

let LatencyStrategy = require("../../../src/strategies/latency");
let { extendExpect } = require("../utils");
const ServiceBroker = require("../../../src/service-broker");

extendExpect(expect);

describe("Test LatencyStrategy", () => {

	const broker = new ServiceBroker();

	it("test with empty opts", () => {

		// this should operate like random

		let strategy = new LatencyStrategy({
			opts: {
				strategyOptions: {}
			}
		}, broker);

		const list = [
			{ a: "hello" },
			{ b: "world" },
		];

		expect(strategy.select(list)).toBeAnyOf(list);
		expect(strategy.select(list)).toBeAnyOf(list);
		expect(strategy.select(list)).toBeAnyOf(list);
	});

});
