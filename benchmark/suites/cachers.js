"use strict";

let { getDataFile } = require("../utils");

let Benchmarkify = require("benchmarkify");
let benchmark = new Benchmarkify("Cachers benchmark").printHeader();

let Moleculer = require("../../");

let key = "TESTKEY-12345";

let bench1 = benchmark.createSuite("Set & get 1k data with cacher");
let data = JSON.parse(getDataFile("1k.json"));

let broker = new Moleculer.ServiceBroker({ logger: false });

let memCacher = new Moleculer.Cachers.Memory();
memCacher.init(broker);

let memCacherCloning = new Moleculer.Cachers.Memory({ clone: true });
memCacherCloning.init(broker);

let redisCacher = new Moleculer.Cachers.Redis({
	redis: {
		uri: "localhost:6379"
	},
	prefix: "BENCH-"
});
redisCacher.init(broker);

// ----
bench1.add("Memory", done => {
	memCacher.set(key, data).then(() => memCacher.get(key)).then(done);
});

bench1.add("Redis", done => {
	redisCacher.set(key, data).then(() => redisCacher.get(key)).then(done);
});

let bench2 = benchmark.createSuite("Test getCacheKey");

bench2.add("Dynamic", () => {
	return memCacher.getCacheKey("user", { id: 5 }, null);
});

bench2.add("Static", () => {
	return memCacher.getCacheKey("user", { id: 5 }, null, ["id"]);
});

let bench3 = benchmark.createSuite("Test cloning on MemoryCacher");
memCacher.set(key, data);
memCacherCloning.set(key, data);

bench3.add("Without cloning", done => {
	memCacher.get(key).then(done);
});

bench3.add("With cloning", done => {
	memCacherCloning.get(key).then(done);
});

benchmark.run([/*bench1, bench2, */bench3]).then(() => {
	redisCacher.close();
});


/*
=====================
  Cachers benchmark
=====================

Platform info:
==============
   Windows_NT 6.1.7601 x64
   Node.JS: 8.9.4
   V8: 6.1.534.50
   Intel(R) Core(TM) i7-4770K CPU @ 3.50GHz × 8

Suite: Set & get 1k data with cacher
√ Memory*        2,066,824 rps
√ Redis*            10,915 rps

   Memory*           0%      (2,066,824 rps)   (avg: 483ns)
   Redis*       -99.47%         (10,915 rps)   (avg: 91μs)
-----------------------------------------------------------------------

Suite: Test getCacheKey
√ Dynamic           679,228 rps
√ Static          5,981,643 rps

   Dynamic       -88.64%        (679,228 rps)   (avg: 1μs)
   Static             0%      (5,981,643 rps)   (avg: 167ns)
-----------------------------------------------------------------------


*/
