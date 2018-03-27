/*
 * moleculer
 * Copyright (c) 2018 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

const cpuUsage 	= require("../cpu-usage");

/**
 * Node class
 *
 * @class Node
 */
class Node {
	/**
	 * Creates an instance of Node.
	 *
	 * @param {String} id
	 *
	 * @memberof Node
	 */
	constructor(id) {
		this.id = id;
		this.available = true;
		this.local = false;
		this.lastHeartbeatTime = Date.now();
		this.config = {};
		this.client = {};

		this.ipList = null;
		this.port = null;
		this.hostname = null;
		this.udpAddress = null;

		this.rawInfo = null;
		this.services = [];

		this.historicLatency = [];
		this.latency = 0;

		this.cpu = null;
		this.cpuSeq = null;

		this.seq = 0;
		this.offlineSince = null;
	}

	/**
	 * Update properties
	 *
	 * @param {any} payload
	 * @memberof Node
	 */
	update(payload) {
		// Update properties
		this.ipList = payload.ipList;
		this.hostname = payload.hostname;
		this.port = payload.port;
		this.client = payload.client || {};

		// Process services & events
		this.services = payload.services;
		this.rawInfo = payload;

		const newSeq = payload.seq || 1;
		if (newSeq > this.seq) {
			this.seq = newSeq;
			return true;
		}
	}

	/**
	 * Update local properties
	 *
	 * @memberof Node
	 */
	updateLocalInfo() {
		return cpuUsage().then(res => {
			const newVal = Math.round(res.avg);
			if (this.cpu != newVal) {
				this.cpu = Math.round(res.avg);
				this.cpuSeq++;
			}
		});
	}

	/**
	 * Update heartbeat properties
	 *
	 * @param {any} payload
	 * @memberof Node
	 */
	heartbeat(payload) {
		if (!this.available) {
			this.available = true;
			this.offlineSince = null;
		}

		this.cpu = payload.cpu;
		this.cpuSeq = payload.cpuSeq || 1;

		this.lastHeartbeatTime = Date.now();
	}

	/**
	 * Update latency properties
	 *
	 * @param {any} payload
	 * @memberof Node
	 */
	updateLatency(payload) {
		if (this.historicLatency.length > 50) this.historicLatency.unshift();
		this.historicLatency.push(payload.elapsedTime);

		this.latency = this.historicLatency.reduce(function(total, latency) {
			return total + latency;
		}) / this.historicLatency.length;
	}

	/**
	 * Node disconnected
	 *
	 * @memberof Node
	 */
	disconnected() {
		if (this.available) {
			this.offlineSince = Date.now();
			this.seq++;
		}

		this.available = false;
	}
}

module.exports = Node;
