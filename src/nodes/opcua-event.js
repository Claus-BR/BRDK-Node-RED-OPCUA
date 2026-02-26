/**
 * @file opcua-event.js
 * @description OPC UA Event node — enriches messages with event subscription metadata.
 *
 * This is a pure message-enriching node with no OPC UA connection.
 * It sets `msg.topic` (source NodeId) and `msg.eventTypeIds` (event type NodeId)
 * so that a downstream Client node can use the "events" action.
 *
 * Supports standard event types via a dropdown or a custom NodeId.
 */

"use strict";

module.exports = function (RED) {

  function OpcUaEventNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // ── Configuration ────────────────────────────────────────────────────
    this.root                = config.root || "";
    this.eventtype           = config.eventtype || "";
    this.customeventtype     = config.customeventtype || "";
    this.activatecustomevent = config.activatecustomevent || false;
    this.name                = config.name || "";

    // ── Input handler ────────────────────────────────────────────────────
    node.on("input", (msg, send, done) => {
      msg.topic = node.root;
      msg.eventTypeIds = node.activatecustomevent
        ? node.customeventtype
        : node.eventtype;

      send(msg);
      done();
    });
  }

  RED.nodes.registerType("opcua-event", OpcUaEventNode);
};
