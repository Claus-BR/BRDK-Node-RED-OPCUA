/**
 * @file opcua-method.js
 * @description OPC UA Method node — calls an OPC UA method with arguments.
 *
 * Creates a per-invocation connection to call the specified method on the
 * given object. Supports up to 3 input arguments and captures all output
 * arguments in the result.
 *
 * Input arguments can be configured in the editor or overridden by msg properties:
 *   msg.objectId       — NodeId of the parent object
 *   msg.methodId       — NodeId of the method
 *   msg.inputArguments  — array of { dataType, value, typeid? } objects
 *
 * Output:
 *   msg.payload — single value (if one output arg) or array of values
 *   msg.result  — full CallMethodResult object (statusCode, outputArguments, etc.)
 *   msg.output  — raw output arguments array
 */

"use strict";

const opcua = require("node-opcua");
const { getClientCertificateManager } = require("../lib/opcua-certificate-manager");
const {
  resolveUserIdentity,
  resolveSecurityMode,
  resolveSecurityPolicy,
  DEFAULT_CONNECTION_STRATEGY,
} = require("../lib/opcua-connection");

module.exports = function (RED) {

  function OpcUaMethodNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // ── Configuration ────────────────────────────────────────────────────
    this.endpointNode = RED.nodes.getNode(config.endpoint);
    this.objectId     = config.objectId || "";
    this.methodId     = config.methodId || "";
    this.name         = config.name || "";

    // ── Build static input arguments from editor config ──────────────────
    this.configuredInputArgs  = buildArgsFromConfig(config, "arg", 3);
    this.configuredOutputArgs = buildArgsFromConfig(config, "out", 1);

    // ── Validate endpoint ────────────────────────────────────────────────
    if (!this.endpointNode) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    node.status({ fill: "grey", shape: "ring", text: "idle" });

    // ── Command queue for sequential processing ──────────────────────────
    let processing = false;
    const cmdQueue = [];

    // ── Input handler ────────────────────────────────────────────────────
    node.on("input", async (msg, send, done) => {
      const command = {
        objectId:        msg.objectId || node.objectId,
        methodId:        msg.methodId || node.methodId,
        inputArguments:  msg.inputArguments || [...node.configuredInputArgs],
        outputArguments: msg.outputArguments || [...node.configuredOutputArgs],
        msg,
        send,
        done,
      };

      if (!command.objectId) {
        node.warn("No objectId specified for method call");
        done();
        return;
      }
      if (!command.methodId) {
        node.warn("No methodId specified for method call");
        done();
        return;
      }

      cmdQueue.push(command);

      if (!processing) {
        await processQueue();
      }
    });

    // ── Queue processor ──────────────────────────────────────────────────
    async function processQueue() {
      if (cmdQueue.length === 0) return;
      processing = true;

      let client = null;
      let session = null;

      try {
        // Initialize certificate manager
        const certManager = getClientCertificateManager();
        await certManager.initialize();

        // Create client
        client = opcua.OPCUAClient.create({
          applicationName: "BRDK-NodeRED-OPCUA-Method",
          clientCertificateManager: certManager,
          securityMode: resolveSecurityMode(node.endpointNode.securityMode),
          securityPolicy: resolveSecurityPolicy(node.endpointNode.securityPolicy),
          endpointMustExist: false,
          connectionStrategy: DEFAULT_CONNECTION_STRATEGY,
        });

        // Connect
        node.status({ fill: "yellow", shape: "dot", text: "connecting" });
        await client.connect(node.endpointNode.endpoint);

        // Create session
        const userIdentity = resolveUserIdentity(node.endpointNode);
        session = await client.createSession(userIdentity);
        node.status({ fill: "green", shape: "dot", text: "session active" });

        // Process all queued commands
        while (cmdQueue.length > 0) {
          const cmd = cmdQueue.shift();
          try {
            await executeMethod(session, cmd);
          } catch (err) {
            node.error(`Method call failed: ${err.message}`, cmd.msg);
            cmd.done(err);
          }
        }

        node.status({ fill: "green", shape: "dot", text: "method executed" });
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "error" });
        node.error(`Method connection error: ${err.message}`);
        // Fail all remaining queued commands
        while (cmdQueue.length > 0) {
          const cmd = cmdQueue.shift();
          cmd.done(err);
        }
      } finally {
        await cleanup(session, client);
        processing = false;

        // If new commands arrived during processing, process them
        if (cmdQueue.length > 0) {
          await processQueue();
        }
      }
    }

    // ── Method execution ─────────────────────────────────────────────────
    async function executeMethod(session, cmd) {
      const { msg, send, done } = cmd;

      // Coerce input arguments
      const inputArgs = await coerceArguments(session, cmd.inputArguments);

      // Build the CallMethodRequest
      node.status({ fill: "green", shape: "dot", text: "calling method" });
      const callMethodRequest = new opcua.CallMethodRequest({
        objectId: opcua.coerceNodeId(cmd.objectId),
        methodId: opcua.coerceNodeId(cmd.methodId),
        inputArguments: inputArgs,
      });

      // Execute the call
      const result = await session.call(callMethodRequest);

      if (result.statusCode !== opcua.StatusCodes.Good) {
        node.status({ fill: "red", shape: "ring", text: result.statusCode.description });
        node.error(`Method returned: ${result.statusCode.description}`, msg);
        done();
        return;
      }

      // Build output
      msg.result = result;
      msg.output = result.outputArguments;

      if (result.outputArguments.length === 1) {
        msg.payload = result.outputArguments[0].value;
      } else if (result.outputArguments.length > 1) {
        msg.payload = result.outputArguments.map((arg) => arg.value);
      } else {
        msg.payload = null;
      }

      send(msg);
      done();
    }

    // ── Close handler ────────────────────────────────────────────────────
    node.on("close", (done) => {
      cmdQueue.length = 0;
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("opcua-method", OpcUaMethodNode);
};

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Build argument array from editor config fields (arg0type/arg0value, arg1type/arg1value, etc.)
 * @param {object} config  — node config
 * @param {string} prefix  — "arg" or "out"
 * @param {number} count   — number of slots to check
 * @returns {Array} array of { dataType, value, typeid? }
 */
function buildArgsFromConfig(config, prefix, count) {
  const args = [];

  for (let i = 0; i < count; i++) {
    const dataType = config[`${prefix}${i}type`];
    const rawValue = config[`${prefix}${i}value`];
    const typeId   = config[`${prefix}${i}typeid`];

    if (!dataType || dataType === "") continue;
    if (rawValue === undefined || rawValue === "") continue;

    const arg = { dataType, value: coerceArgValue(dataType, rawValue) };
    if (typeId) arg.typeid = typeId;
    args.push(arg);
  }

  return args;
}

/**
 * Coerce a raw string value to the appropriate JS type based on OPC UA data type.
 */
function coerceArgValue(dataType, rawValue) {
  switch (dataType) {
    case "Boolean":
      return rawValue === "True" || rawValue === "true" || rawValue === true;
    case "DateTime":
      return new Date(rawValue);
    case "NodeId":
      return opcua.coerceNodeId(rawValue);
    case "String":
    case "LocalizedText":
      return rawValue;
    case "ExtensionObject":
      return typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    case "Double":
    case "Float":
      return parseFloat(rawValue);
    case "Int16":
    case "Int32":
    case "Int64":
    case "UInt16":
    case "UInt32":
    case "UInt64":
    case "SByte":
    case "Byte":
      return parseInt(rawValue, 10);
    default:
      return rawValue;
  }
}

/**
 * Coerce argument values, resolving ExtensionObjects via session.constructExtensionObject().
 */
async function coerceArguments(session, args) {
  const coerced = [];

  for (const arg of args) {
    const entry = { dataType: opcua.DataType[arg.dataType], value: arg.value };

    if (arg.dataType === "NodeId") {
      entry.value = opcua.coerceNodeId(arg.value);
    } else if (arg.dataType === "ExtensionObject" && arg.typeid) {
      entry.value = await session.constructExtensionObject(
        opcua.coerceNodeId(arg.typeid),
        arg.value,
      );
    } else if (arg.dataType === "LocalizedText") {
      // LocalizedText as array with valueRank
      entry.value = [arg.value];
      entry.valueRank = 1;
      entry.arrayDimensions = [1];
    }

    coerced.push(entry);
  }

  return coerced;
}

/**
 * Gracefully close session and disconnect client.
 */
async function cleanup(session, client) {
  try {
    if (session) await session.close(true);
  } catch { /* already closed */ }
  try {
    if (client) await client.disconnect();
  } catch { /* already disconnected */ }
}
