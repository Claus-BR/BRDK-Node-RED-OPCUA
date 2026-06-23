/**
 * @file opcua-subscription.js
 * @description OPC UA Subscription configuration node.
 *
 * This is a Node-RED **config node** that stores subscription parameters.
 * It is referenced by Action and Client nodes to group monitored items
 * into separate subscriptions with independent publishing intervals.
 *
 * Stores:
 *   - Publishing interval (value + unit)
 *   - Sampling interval (value + unit)
 *   - Queue size for monitored items
 *   - Lifetime count, max keep-alive count, max notifications per publish
 *   - Priority
 */

'use strict';

module.exports = function (RED) {
  /**
   * Convert a value + unit pair into milliseconds.
   */
  function toMilliseconds(value, unit) {
    switch (unit) {
      case 'ms':
        return value;
      case 's':
        return value * 1000;
      case 'm':
        return value * 60000;
      case 'h':
        return value * 3600000;
      default:
        return value;
    }
  }

  function OpcUaSubscriptionNode(config) {
    RED.nodes.createNode(this, config);

    this.name = config.name || '';

    // Publishing interval
    const pubTime = Number(config.publishingTime) || 1;
    const pubUnit = config.publishingTimeUnit || 's';
    this.publishingInterval = toMilliseconds(pubTime, pubUnit);

    // Sampling interval
    const sampTime = Number(config.samplingTime) || 0;
    const sampUnit = config.samplingTimeUnit || 's';
    this.samplingInterval = sampTime === 0 ? 0 : toMilliseconds(sampTime, sampUnit);

    this.queueSize = Number(config.queueSize) || 10;
    this.discardOldest = config.discardOldest !== false;
    this.lifetimeCount = Number(config.lifetimeCount) || 60;
    this.maxKeepAliveCount = Number(config.maxKeepAliveCount) || 10;
    this.maxNotificationsPerPublish = Number(config.maxNotificationsPerPublish) || 10;
    this.priority = Number(config.priority) || 10;
  }

  RED.nodes.registerType('opcua-subscription', OpcUaSubscriptionNode);
};
