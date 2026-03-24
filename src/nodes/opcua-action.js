/**
 * @file opcua-action.js
 * @description OPC UA Action node — sets `msg.action` and action-specific
 * configuration for downstream Client nodes.
 *
 * Depending on the selected action, additional message properties are set:
 *   - subscribe/monitor/events: `msg.interval`, `msg.queueSize`
 *   - monitor:                  `msg.deadbandType`, `msg.deadbandValue`
 *   - events:                   `msg.customEventFields`, `msg.eventTypeIds`
 *   - browse:                   `msg.collect`, `msg.maxDepth`
 *   - history:                  `msg.aggregate`, `msg.numValuesPerNode`,
 *                               `msg.processingInterval`, `msg.returnBounds`,
 *                               `msg.start`, `msg.end`
 *   - acknowledge:              `msg.comment`
 *   - method:                   `msg.objectId`, `msg.methodId`
 *   - connect/reconnect:        `msg.OpcUaEndpoint`
 *
 * ─── Outputs ──────────────────────────────────────────────────────────
 *   Output 1 — Message with `msg.action` and sub-configuration set
 */

"use strict";

module.exports = function (RED) {

  function OpcUaActionNode(config) {
    RED.nodes.createNode(this, config);

    // ── Common ─────────────────────────────────────────────────────────
    this.action = config.action || "read";
    this.name   = config.name   || "";

    // ── Monitor only ────────────────────────────────────────────────────
    this.deadbandType  = config.deadbandtype || "a";
    this.deadbandValue = Number(config.deadbandvalue) || 1;

    // ── Events only ─────────────────────────────────────────────────────
    this.customEventFields = config.customEventFields || "";
    this.eventTypeSelect   = config.eventTypeSelect || "i=2041";
    this.eventTypeIds      = config.eventTypeIds || "";

    // ── Browse ──────────────────────────────────────────────────────────
    this.collect  = config.collect === true;
    this.maxDepth = Number(config.maxDepth) || 1;

    // ── History ─────────────────────────────────────────────────────────
    this.aggregate          = config.aggregate || "raw";
    this.numValuesPerNode   = Number(config.numValuesPerNode) || 1000;
    this.processingInterval = Number(config.processingInterval) || 3600000;
    this.returnBounds       = config.returnBounds === true;

    // ── History time range ─────────────────────────────────────────────
    this.historyRange     = Number(config.historyRange) || 1;
    this.historyRangeUnit = config.historyRangeUnit || "h";

    // ── Acknowledge ─────────────────────────────────────────────────────
    this.comment = config.comment || "Acknowledged from Node-RED";

    // ── Method ──────────────────────────────────────────────────────────
    this.objectId = config.objectId || "";
    this.methodId = config.methodId || "";

    // ── Connect / Reconnect ─────────────────────────────────────────────
    this.endpointUrl = config.endpointUrl || "";

    // ── Subscription config node reference ──────────────────────────────
    this.subscriptionNode = RED.nodes.getNode(config.subscription);

    const node = this;

    // ── Input handler ────────────────────────────────────────────────────
    node.on("input", (msg, send, done) => {
      msg.action = node.action;

      switch (node.action) {
        case "subscribe":
          if (node.subscriptionNode) {
            msg.subscriptionId = msg.subscriptionId || node.subscriptionNode.id;
          }
          break;

        case "events":
          if (node.subscriptionNode) {
            msg.subscriptionId = msg.subscriptionId || node.subscriptionNode.id;
          }
          break;

        case "monitor":
          msg.deadbandType  = msg.deadbandType  || node.deadbandType;
          msg.deadbandValue = msg.deadbandValue ?? node.deadbandValue;
          if (node.subscriptionNode) {
            msg.subscriptionId = msg.subscriptionId || node.subscriptionNode.id;
          }
          break;

        case "browse":
          msg.collect  = node.collect;
          msg.maxDepth = msg.maxDepth || node.maxDepth;
          break;

        case "history": {
          msg.aggregate          = msg.aggregate          || node.aggregate;
          msg.numValuesPerNode   = msg.numValuesPerNode   || node.numValuesPerNode;
          msg.processingInterval = msg.processingInterval || node.processingInterval;
          msg.returnBounds       = msg.returnBounds       ?? node.returnBounds;
          // Compute start/end from relative range if not already set
          const rangeMs = toMilliseconds(node.historyRange, node.historyRangeUnit);
          const now     = new Date();
          msg.end   = msg.end   || now;
          msg.start = msg.start || new Date(now.getTime() - rangeMs);
          break;
        }

        case "acknowledge":
          msg.comment = msg.comment || node.comment;
          break;

        case "method":
          msg.objectId = msg.objectId || node.objectId;
          msg.methodId = msg.methodId || node.methodId;
          break;

        case "unsubscribe":
        case "deletesubscription":
          if (node.subscriptionNode) {
            msg.subscriptionId = msg.subscriptionId || node.subscriptionNode.id;
          }
          break;

        case "connect":
        case "reconnect":
          if (node.endpointUrl) {
            msg.OpcUaEndpoint = msg.OpcUaEndpoint || {};
            msg.OpcUaEndpoint.endpoint = msg.OpcUaEndpoint.endpoint || node.endpointUrl;
          }
          break;
      }

      // Events: parse custom fields from comma-separated string
      if (node.action === "events" && node.customEventFields) {
        const fields = node.customEventFields
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
        if (fields.length > 0) {
          msg.customEventFields = msg.customEventFields || fields;
        }
      }

      // Events: resolve event type IDs from dropdown or custom field
      if (node.action === "events") {
        if (!msg.eventTypeIds) {
          if (node.eventTypeSelect === "custom" && node.eventTypeIds) {
            // Custom: parse comma-separated NodeIds
            const ids = node.eventTypeIds
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean);
            if (ids.length > 0) {
              msg.eventTypeIds = ids;
            }
          } else if (node.eventTypeSelect && node.eventTypeSelect !== "custom") {
            // Standard dropdown selection — single NodeId
            msg.eventTypeIds = node.eventTypeSelect;
          }
        }
      }

      send(msg);
      done();
    });
  }

  RED.nodes.registerType("opcua-action", OpcUaActionNode);
};

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Convert a time value + unit to milliseconds.
 *
 * @param {number} value - The numeric time value.
 * @param {string} unit  - One of "ms", "s", "m", "h".
 * @returns {number} Time in milliseconds.
 */
function toMilliseconds(value, unit) {
  const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return value * (multipliers[unit] || 1000);
}
