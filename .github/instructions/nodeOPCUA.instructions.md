---
applyTo: "**/*.{js,ts,html}"
description: "node-opcua library best practices and syntax reference for the node-red-contrib-opcua project"
name: "nodeOPCUA Best Practices & Syntax"
---

# node-opcua Library Best Practices & Syntax Reference

> Based on [node-opcua API v2.132.0](https://node-opcua.github.io/api_doc/2.132.0/index.html)

## Table of Contents

1. [Importing & Module Structure](#importing--module-structure)
2. [OPCUAClient - Creation & Connection](#opcuaclient---creation--connection)
3. [Session Management](#session-management)
4. [Reading Values](#reading-values)
5. [Writing Values](#writing-values)
6. [Subscriptions & Monitored Items](#subscriptions--monitored-items)
7. [Browsing the Address Space](#browsing-the-address-space)
8. [Method Calls](#method-calls)
9. [Events & Alarms](#events--alarms)
10. [OPCUAServer - Creation & Lifecycle](#opcuaserver---creation--lifecycle)
11. [Address Space Manipulation (Server)](#address-space-manipulation-server)
12. [Security & Certificates](#security--certificates)
13. [Data Types & Variants](#data-types--variants)
14. [Node IDs](#node-ids)
15. [Status Codes](#status-codes)
16. [File Transfer](#file-transfer)
17. [Extension Objects](#extension-objects)
18. [Connection Strategy & Reconnection](#connection-strategy--reconnection)
19. [Error Handling Best Practices](#error-handling-best-practices)
20. [Client Events Reference](#client-events-reference)
21. [Server Events Reference](#server-events-reference)

---

## Importing & Module Structure

```js
// Main import - provides access to all sub-modules
const opcua = require("node-opcua");

// Common direct imports used in this project
const { OPCUAClient, OPCUAServer } = require("node-opcua");
const { DataValue } = require("node-opcua");
const { NodeCrawler } = require("node-opcua-client-crawler");
const fileTransfer = require("node-opcua-file-transfer");
const { coerceNodeId, coerceLocalizedText } = require("node-opcua");

// Crypto utilities for certificate handling
const crypto_utils = opcua.crypto_utils;
```

### Key Sub-Modules

| Module | Purpose |
|--------|---------|
| `node-opcua-client` | OPCUAClient, ClientSession, ClientSubscription |
| `node-opcua-server` | OPCUAServer, ServerEngine, AddressSpace |
| `node-opcua-variant` | Variant, DataType, VariantArrayType |
| `node-opcua-data-value` | DataValue |
| `node-opcua-nodeid` | NodeId, coerceNodeId, resolveNodeId |
| `node-opcua-status-code` | StatusCodes, StatusCode |
| `node-opcua-basic-types` | Basic OPC UA types |
| `node-opcua-numeric-range` | NumericRange |
| `node-opcua-client-crawler` | NodeCrawler for browsing |
| `node-opcua-file-transfer` | ClientFile for OPC UA file transfer |

---

## OPCUAClient - Creation & Connection

### Creating a Client

Always use the static `OPCUAClient.create()` factory method (not `new OPCUAClient()`):

```js
const client = opcua.OPCUAClient.create({
  applicationName: "MyOPCUAClient",
  applicationUri: "urn:MyOPCUAClient",
  clientName: "MyClientInstance",
  
  // Security
  securityMode: opcua.MessageSecurityMode.None,
  securityPolicy: opcua.SecurityPolicy.None,
  
  // Token lifetime
  defaultSecureTokenLifetime: 40000,
  requestedSessionTimeout: 60000,
  keepSessionAlive: true,
  
  // Endpoint validation
  endpointMustExist: false,
  
  // Certificate management
  clientCertificateManager: certificateManager,
  
  // Connection strategy
  connectionStrategy: {
    maxRetry: 10,
    initialDelay: 2000,
    maxDelay: 10000
  },
  
  // Transport settings (for large data)
  transportSettings: {
    maxChunkCount: 16,
    maxMessageSize: 64 * 1024,
    receiveBufferSize: 64 * 1024,
    sendBufferSize: 64 * 1024
  }
});
```

### Connecting to a Server

```js
// Promise-based (preferred)
await client.connect("opc.tcp://localhost:4840");

// Callback-based
client.connect("opc.tcp://localhost:4840", (err) => {
  if (err) { console.error("Connection failed:", err.message); }
});
```

### Disconnecting

**Important:** Once disconnected, a client cannot reconnect. You must create a new client instance.

```js
await client.disconnect();
```

### High-Level Convenience Methods

```js
// withSessionAsync - manages connect/session/disconnect lifecycle
const result = await OPCUAClient.create(options)
  .withSessionAsync("opc.tcp://localhost:4840", async (session) => {
    const dataValue = await session.read({ nodeId: "ns=1;s=Temperature" });
    return dataValue.value.value;
  });

// withSubscriptionAsync - manages full subscription lifecycle
await client.withSubscriptionAsync(
  "opc.tcp://localhost:4840",
  { requestedPublishingInterval: 1000 },
  async (session, subscription) => {
    // Use session and subscription
  }
);
```

---

## Session Management

### Creating a Session

```js
// Anonymous session
const session = await client.createSession();

// With user identity
const session = await client.createSession({
  type: opcua.UserTokenType.UserName,
  userName: "admin",
  password: "secret"
});

// With X.509 certificate identity
const session = await client.createSession({
  type: opcua.UserTokenType.Certificate,
  certificateData: certificateBuffer,
  privateKey: privateKeyPEM
});
```

### UserTokenType Enum

| Value | Description |
|-------|-------------|
| `opcua.UserTokenType.Anonymous` | No credentials |
| `opcua.UserTokenType.UserName` | Username and password |
| `opcua.UserTokenType.Certificate` | X.509 certificate |

### Closing a Session

```js
await client.closeSession(session, /* deleteSubscriptions */ true);
// Or simply:
await session.close(/* deleteSubscriptions */ true);
```

### Session Events

```js
session.on("session_closed", (statusCode) => {
  console.log("Session closed, status:", statusCode);
});

session.on("keepalive", (lastKnownServerState) => {
  console.log("Keep-alive, server state:", lastKnownServerState);
});
```

### Change Session Identity (at runtime)

```js
const statusCode = await client.changeSessionIdentity(session, {
  type: opcua.UserTokenType.UserName,
  userName: "newUser",
  password: "newPassword"
});
```

---

## Reading Values

### Single Read

```js
const dataValue = await session.read({
  nodeId: "ns=1;s=Temperature",
  attributeId: opcua.AttributeIds.Value
});

console.log("Value:", dataValue.value.value);
console.log("Status:", dataValue.statusCode.toString());
console.log("Timestamp:", dataValue.sourceTimestamp);
```

### Multiple Reads

```js
const nodesToRead = [
  { nodeId: "ns=1;s=Temperature", attributeId: opcua.AttributeIds.Value },
  { nodeId: "ns=1;s=Pressure", attributeId: opcua.AttributeIds.Value }
];

const dataValues = await session.read(nodesToRead);
dataValues.forEach((dv, i) => {
  console.log(`Node ${i}: ${dv.value.value}`);
});
```

### Read All Attributes of a Node

```js
const result = await session.readAllAttributes("ns=1;s=MyNode");
```

### Read with Index Range (Array Subsets)

```js
const dataValue = await session.read({
  nodeId: "ns=1;s=MyArray",
  attributeId: opcua.AttributeIds.Value,
  indexRange: new opcua.NumericRange("2:5") // Elements 2-5
});
```

### Read with Timestamps

```js
const dataValue = await session.read({
  nodeId: "ns=1;s=Temperature",
  attributeId: opcua.AttributeIds.Value
}, null, opcua.TimestampsToReturn.Both);
```

### TimestampsToReturn Enum

| Value | Description |
|-------|-------------|
| `opcua.TimestampsToReturn.Source` | Source timestamp only |
| `opcua.TimestampsToReturn.Server` | Server timestamp only |
| `opcua.TimestampsToReturn.Both` | Both timestamps |
| `opcua.TimestampsToReturn.Neither` | No timestamps |

### Common AttributeIds

| AttributeId | Value | Description |
|-------------|-------|-------------|
| `opcua.AttributeIds.NodeId` | 1 | The NodeId |
| `opcua.AttributeIds.BrowseName` | 3 | Browse name |
| `opcua.AttributeIds.DisplayName` | 4 | Display name |
| `opcua.AttributeIds.Value` | 13 | Current value |
| `opcua.AttributeIds.DataType` | 14 | Data type NodeId |
| `opcua.AttributeIds.AccessLevel` | 17 | Access level |

### Read History Values

```js
const result = await session.readHistoryValue(
  "ns=1;s=Temperature",
  new Date("2024-01-01"),  // startTime
  new Date()                // endTime
);
```

### Read Aggregate Values

```js
const result = await session.readAggregateValue(
  { nodeId: "ns=1;s=Temperature" },
  new Date("2024-01-01"),
  new Date(),
  opcua.AggregateFunction.Average,  // or Maximum, Minimum, Interpolative
  3600000  // processingInterval in ms
);
```

---

## Writing Values

### Building a DataValue for Writing

```js
// Simple value write
const dataValue = new opcua.DataValue({
  value: new opcua.Variant({
    dataType: opcua.DataType.Double,
    value: 42.0
  })
});

// With timestamps
const dataValue = new opcua.DataValue({
  value: new opcua.Variant({
    dataType: opcua.DataType.String,
    value: "Hello"
  }),
  sourceTimestamp: new Date(),
  serverTimestamp: new Date()
});
```

### Writing to a Node

```js
const statusCode = await session.write({
  nodeId: "ns=1;s=Temperature",
  attributeId: opcua.AttributeIds.Value,
  value: new opcua.DataValue({
    value: new opcua.Variant({
      dataType: opcua.DataType.Double,
      value: 25.5
    })
  })
});

if (statusCode.equals(opcua.StatusCodes.Good)) {
  console.log("Write successful");
}
```

### Writing Multiple Values

```js
const statusCodes = await session.write([
  {
    nodeId: "ns=1;s=Temp1",
    attributeId: opcua.AttributeIds.Value,
    value: { value: { dataType: opcua.DataType.Double, value: 10.0 } }
  },
  {
    nodeId: "ns=1;s=Temp2",
    attributeId: opcua.AttributeIds.Value,
    value: { value: { dataType: opcua.DataType.Double, value: 20.0 } }
  }
]);
```

---

## Subscriptions & Monitored Items

### Creating a Subscription

Use the static `ClientSubscription.create()` factory method:

```js
const subscription = opcua.ClientSubscription.create(session, {
  requestedPublishingInterval: 100,    // ms
  requestedLifetimeCount: 60,
  requestedMaxKeepAliveCount: 10,
  maxNotificationsPerPublish: 10,
  publishingEnabled: true,
  priority: 10
});
```

### Subscription Events

```js
subscription.on("initialized", () => {
  console.log("Subscription initialized");
});

subscription.on("started", () => {
  console.log("Subscription started, ID:", subscription.subscriptionId);
});

subscription.on("keepalive", () => {
  console.log("Subscription keepalive");
});

subscription.on("terminated", () => {
  console.log("Subscription terminated");
});

subscription.on("error", (err) => {
  console.error("Subscription error:", err.message);
});
```

### Subscription Parameters for Events vs Data

```js
// For data monitoring (higher throughput)
const dataParams = {
  requestedPublishingInterval: 100,
  requestedLifetimeCount: 30,
  requestedMaxKeepAliveCount: 3,
  maxNotificationsPerPublish: 10,
  publishingEnabled: true,
  priority: 10
};

// For event monitoring (lower throughput, longer lifetime)
const eventParams = {
  requestedPublishingInterval: 100,
  requestedLifetimeCount: 120,
  requestedMaxKeepAliveCount: 3,
  maxNotificationsPerPublish: 4,
  publishingEnabled: true,
  priority: 1
};
```

### Creating Monitored Items

```js
// Monitor a data value
const monitoredItem = opcua.ClientMonitoredItem.create(
  subscription,
  {
    nodeId: "ns=1;s=Temperature",
    attributeId: opcua.AttributeIds.Value
  },
  {
    samplingInterval: 100,       // ms
    discardOldest: true,
    queueSize: 10
  },
  opcua.TimestampsToReturn.Both
);

monitoredItem.on("changed", (dataValue) => {
  console.log("Value changed:", dataValue.value.value);
  console.log("Timestamp:", dataValue.sourceTimestamp);
  console.log("Status:", dataValue.statusCode.toString());
});

monitoredItem.on("err", (err) => {
  console.error("Monitored item error:", err);
});
```

### Monitoring a Group of Items

```js
const itemsToMonitor = [
  { nodeId: "ns=1;s=Temp1", attributeId: opcua.AttributeIds.Value },
  { nodeId: "ns=1;s=Temp2", attributeId: opcua.AttributeIds.Value }
];

const group = opcua.ClientMonitoredItemGroup.create(
  subscription,
  itemsToMonitor,
  { samplingInterval: 100, discardOldest: true, queueSize: 10 },
  opcua.TimestampsToReturn.Both
);

group.on("changed", (monitoredItem, dataValue, index) => {
  console.log(`Item ${index} changed:`, dataValue.value.value);
});
```

### Terminating a Subscription

```js
await subscription.terminate();
```

### Register / Unregister Nodes (Performance Optimization)

```js
// Register nodes for faster repeated access
const registeredNodes = await session.registerNodes(["ns=1;s=Temp1", "ns=1;s=Temp2"]);

// Use registeredNodes for reads/writes...

// Unregister when done
await session.unregisterNodes(registeredNodes);
```

---

## Browsing the Address Space

### Basic Browse

```js
const browseResult = await session.browse("RootFolder");

browseResult.references.forEach((ref) => {
  console.log("Node:", ref.browseName.toString());
  console.log("  NodeId:", ref.nodeId.toString());
  console.log("  NodeClass:", ref.nodeClass);
  console.log("  TypeDefinition:", ref.typeDefinition?.toString());
});
```

### Browse with Description

```js
const browseResult = await session.browse({
  nodeId: "ns=1;i=1000",
  browseDirection: opcua.BrowseDirection.Forward,
  referenceTypeId: "Organizes",
  includeSubtypes: true,
  nodeClassMask: 0,  // all node classes
  resultMask: 63     // all fields
});
```

### BrowseDirection Enum

| Value | Description |
|-------|-------------|
| `opcua.BrowseDirection.Forward` | Forward references |
| `opcua.BrowseDirection.Inverse` | Inverse references |
| `opcua.BrowseDirection.Both` | Both directions |

### Translate Browse Path

```js
const browsePath = opcua.makeBrowsePath(
  "RootFolder",
  "/Objects/Server.ServerStatus.BuildInfo"
);

const result = await session.translateBrowsePath(browsePath);
const targetNodeId = result.targets[0].targetId;
```

### Node Crawler (Deep Browsing)

```js
const { NodeCrawler } = require("node-opcua-client-crawler");

const crawler = new NodeCrawler(session);
crawler.on("browsed", (element) => {
  console.log("Found:", element.browseName.toString());
});

await crawler.read(opcua.resolveNodeId("RootFolder"));
```

---

## Method Calls

### Call a Method

```js
const callMethodRequest = new opcua.CallMethodRequest({
  objectId: opcua.coerceNodeId("ns=1;i=1000"),  // Parent object
  methodId: opcua.coerceNodeId("ns=1;i=1001"),  // Method node
  inputArguments: [
    new opcua.Variant({ dataType: opcua.DataType.String, value: "Hello" }),
    new opcua.Variant({ dataType: opcua.DataType.UInt32, value: 42 })
  ]
});

const result = await session.call(callMethodRequest);

if (result.statusCode.equals(opcua.StatusCodes.Good)) {
  result.outputArguments.forEach((arg) => {
    console.log("Output:", arg.value);
  });
}
```

### Get Method Argument Definitions

```js
const argDef = await session.getArgumentDefinition(methodNodeId);
console.log("Input args:", argDef.inputArguments);
console.log("Output args:", argDef.outputArguments);
```

---

## Events & Alarms

### Monitor Events

```js
const eventFilter = opcua.constructEventFilter([
  "SourceName", "EventId", "ReceiveTime", "Severity",
  "Message", "ConditionName", "ConditionType"
]);

const monitoredItem = opcua.ClientMonitoredItem.create(
  subscription,
  {
    nodeId: opcua.resolveNodeId("Server"),  // Typically monitor the Server object
    attributeId: opcua.AttributeIds.EventNotifier
  },
  {
    samplingInterval: 0,
    discardOldest: true,
    queueSize: 100,
    filter: eventFilter
  }
);

monitoredItem.on("changed", (eventFields) => {
  // eventFields is an array of Variant values matching the select clause
  console.log("Event received:", eventFields);
});
```

### Acknowledge a Condition

```js
const statusCode = await session.acknowledgeCondition(
  conditionNodeId,    // The condition node
  eventId,            // The EventId (ByteString)
  "Acknowledged by operator"  // Comment
);
```

### Confirm a Condition

```js
const statusCode = await session.confirmCondition(
  conditionNodeId,
  eventId,
  "Confirmed by operator"
);
```

---

## OPCUAServer - Creation & Lifecycle

### Creating a Server

```js
const server = new opcua.OPCUAServer({
  port: 4840,
  
  // Resource URI
  resourcePath: "/UA/MyServer",
  
  // Build info
  buildInfo: {
    productName: "MyOPCUAServer",
    buildNumber: "1",
    buildDate: new Date()
  },
  
  // Security configuration
  allowAnonymous: true,
  
  // Security policies on endpoints
  securityPolicies: [
    opcua.SecurityPolicy.None,
    opcua.SecurityPolicy.Basic256Sha256
  ],
  securityModes: [
    opcua.MessageSecurityMode.None,
    opcua.MessageSecurityMode.SignAndEncrypt
  ],
  
  // Certificate management
  serverCertificateManager: serverCertManager,
  userCertificateManager: userCertManager,
  
  // User management
  userManager: {
    isValidUser: (userName, password) => {
      return userName === "admin" && password === "secret";
    }
  },
  
  // Connection limits
  maxConnectionsPerEndpoint: 20,
  maxAllowedSessionNumber: 10,
  
  // Timeouts
  timeout: 10000,
  
  // Node sets
  nodeset_filename: [
    opcua.nodesets.standard,
    "path/to/custom/nodeset.xml"
  ],
  
  // Discovery
  registerServerMethod: opcua.RegisterServerMethod.LDS,
  discoveryServerEndpointUrl: "opc.tcp://localhost:4840",
  
  // Operating limits
  serverCapabilities: {
    operationLimits: {
      maxNodesPerRead: 1000,
      maxNodesPerWrite: 1000,
      maxNodesPerBrowse: 1000,
      maxNodesPerMethodCall: 100,
      maxNodesPerRegisterNodes: 1000
    }
  }
});
```

### Server Lifecycle

```js
// 1. Initialize (install default node set)
await server.initialize();

// 2. Configure address space (after initialize, before start)
const addressSpace = server.engine.addressSpace;
const namespace = addressSpace.getOwnNamespace();

// Add objects & variables here...

// 3. Start listening
await server.start();
console.log("Server endpoint:", server.getEndpointUrl());

// 4. Shutdown (with optional timeout in ms)
server.engine.shutdownReason = opcua.coerceLocalizedText("Maintenance");
await server.shutdown(10000);
```

---

## Address Space Manipulation (Server)

### Add a Variable

```js
const namespace = server.engine.addressSpace.getOwnNamespace();
const objectsFolder = addressSpace.rootFolder.objects;

namespace.addVariable({
  componentOf: objectsFolder,
  browseName: "Temperature",
  dataType: "Double",
  value: {
    get: () => new opcua.Variant({ dataType: opcua.DataType.Double, value: 25.5 }),
    set: (variant) => {
      // handle write
      return opcua.StatusCodes.Good;
    }
  }
});
```

### Add an Object

```js
namespace.addObject({
  organizedBy: objectsFolder,
  browseName: "MyDevice"
});
```

### Add a Method

```js
namespace.addMethod(parentObject, {
  browseName: "DoSomething",
  inputArguments: [
    {
      name: "input1",
      dataType: opcua.DataType.String,
      description: "First input"
    }
  ],
  outputArguments: [
    {
      name: "result",
      dataType: opcua.DataType.Boolean,
      description: "Success flag"
    }
  ]
}).bindMethod((inputArguments, context, callback) => {
  const result = inputArguments[0].value;
  callback(null, {
    statusCode: opcua.StatusCodes.Good,
    outputArguments: [
      { dataType: opcua.DataType.Boolean, value: true }
    ]
  });
});
```

---

## Security & Certificates

### SecurityPolicy Enum (Common Values)

| Policy | Description |
|--------|-------------|
| `opcua.SecurityPolicy.None` | No security |
| `opcua.SecurityPolicy.Basic128Rsa15` | Deprecated, avoid in production |
| `opcua.SecurityPolicy.Basic256` | SHA-1 based, being phased out |
| `opcua.SecurityPolicy.Basic256Sha256` | **Recommended** for production |
| `opcua.SecurityPolicy.Aes128_Sha256_RsaOaep` | Modern alternative |
| `opcua.SecurityPolicy.Aes256_Sha256_RsaPss` | Strongest option |

### MessageSecurityMode Enum

| Mode | Description |
|------|-------------|
| `opcua.MessageSecurityMode.None` | No security |
| `opcua.MessageSecurityMode.Sign` | Messages are signed |
| `opcua.MessageSecurityMode.SignAndEncrypt` | **Recommended** - signed and encrypted |

### Creating a Certificate Manager (Client)

```js
const { OPCUACertificateManager } = require("node-opcua");

const clientCertificateManager = new OPCUACertificateManager({
  automaticallyAcceptUnknownCertificate: true,
  rootFolder: "./pki"
});
await clientCertificateManager.initialize();
```

### Reading Certificates

```js
const certificate = crypto_utils.readCertificate("path/to/cert.pem");
const privateKey = crypto_utils.readPrivateKeyPEM("path/to/key.pem");
```

---

## Data Types & Variants

### Creating Variants

The `Variant` class wraps OPC UA values with type information:

```js
// Scalar values
new opcua.Variant({ dataType: opcua.DataType.Boolean, value: true });
new opcua.Variant({ dataType: opcua.DataType.Int32, value: 42 });
new opcua.Variant({ dataType: opcua.DataType.Double, value: 3.14 });
new opcua.Variant({ dataType: opcua.DataType.String, value: "Hello" });
new opcua.Variant({ dataType: opcua.DataType.DateTime, value: new Date() });
new opcua.Variant({ dataType: opcua.DataType.ByteString, value: Buffer.from("data") });

// Array values
new opcua.Variant({
  dataType: opcua.DataType.Double,
  arrayType: opcua.VariantArrayType.Array,
  value: [1.0, 2.0, 3.0]
});

// Using typed arrays for better performance
new opcua.Variant({
  dataType: opcua.DataType.Float,
  arrayType: opcua.VariantArrayType.Array,
  value: new Float32Array([1.0, 2.0, 3.0])
});
```

### DataType Enum (Common Types)

| Type | OPC UA ID | JavaScript Type |
|------|-----------|-----------------|
| `DataType.Boolean` | i=1 | `boolean` |
| `DataType.SByte` | i=2 | `number` (-128 to 127) |
| `DataType.Byte` | i=3 | `number` (0 to 255) |
| `DataType.Int16` | i=4 | `number` |
| `DataType.UInt16` | i=5 | `number` |
| `DataType.Int32` | i=6 | `number` |
| `DataType.UInt32` | i=7 | `number` |
| `DataType.Int64` | i=8 | `[high, low]` array |
| `DataType.UInt64` | i=9 | `[high, low]` array |
| `DataType.Float` | i=10 | `number` |
| `DataType.Double` | i=11 | `number` |
| `DataType.String` | i=12 | `string` |
| `DataType.DateTime` | i=13 | `Date` |
| `DataType.Guid` | i=14 | `string` |
| `DataType.ByteString` | i=15 | `Buffer` |
| `DataType.XmlElement` | i=16 | `string` |
| `DataType.NodeId` | i=17 | `NodeId` |
| `DataType.LocalizedText` | i=21 | `LocalizedText` / `string` |
| `DataType.QualifiedName` | i=20 | `QualifiedName` |
| `DataType.ExtensionObject` | i=22 | `ExtensionObject` |

### VariantArrayType Enum

| Type | Description |
|------|-------------|
| `opcua.VariantArrayType.Scalar` | Single value (default) |
| `opcua.VariantArrayType.Array` | One-dimensional array |
| `opcua.VariantArrayType.Matrix` | Multi-dimensional array |

### Typed Array Mapping

| OPC UA Type | JavaScript Typed Array |
|-------------|----------------------|
| SByte / Int8 | `Int8Array` |
| Byte / UInt8 | `Uint8Array` |
| Int16 | `Int16Array` |
| UInt16 | `Uint16Array` |
| Int32 | `Int32Array` |
| UInt32 | `Uint32Array` |
| Float | `Float32Array` |
| Double | `Float64Array` |

---

## Node IDs

### NodeId Formats

```js
// String NodeId
opcua.coerceNodeId("ns=1;s=Temperature");

// Numeric NodeId
opcua.coerceNodeId("ns=0;i=2253");

// GUID NodeId
opcua.coerceNodeId("ns=1;g=12345678-1234-1234-1234-123456789012");

// Opaque (ByteString) NodeId
opcua.coerceNodeId("ns=1;b=Base64EncodedData");

// Using makeNodeId
opcua.makeNodeId(2253, 0);         // Numeric
opcua.makeNodeId("Temperature", 1); // String

// Resolve well-known NodeIds
opcua.resolveNodeId("RootFolder");  // i=84
opcua.resolveNodeId("Server");      // i=2253
```

### ExpandedNodeId

```js
const expandedNodeId = opcua.makeExpandedNodeId(1234, 1);
const nodeId = opcua.coerceExpandedNodeId("svr=0;ns=1;i=1234");
```

---

## Status Codes

### Checking Status Codes

```js
const dataValue = await session.read({ nodeId: "ns=1;s=Temp" });

// Check if Good
if (dataValue.statusCode.equals(opcua.StatusCodes.Good)) {
  console.log("Value is good");
}

// Check with isGood / isBad helper
if (dataValue.statusCode.isGood()) {
  console.log("Good quality");
}

// Get string representation
console.log(dataValue.statusCode.toString());
// e.g., "Good (0x00000000)"
```

### Common StatusCodes

| Code | Description |
|------|-------------|
| `StatusCodes.Good` | Operation succeeded |
| `StatusCodes.BadNodeIdUnknown` | Node does not exist |
| `StatusCodes.BadSessionIdInvalid` | Session has expired/invalid |
| `StatusCodes.BadCommunicationError` | Communication failure |
| `StatusCodes.BadTimeout` | Operation timed out |
| `StatusCodes.BadNotReadable` | Node is not readable |
| `StatusCodes.BadNotWritable` | Node is not writable |
| `StatusCodes.BadTypeMismatch` | Wrong data type provided |
| `StatusCodes.BadOutOfRange` | Value out of range |
| `StatusCodes.BadUserAccessDenied` | Insufficient permissions |
| `StatusCodes.BadInvalidArgument` | Invalid method argument |

---

## File Transfer

### OPC UA File Transfer (using node-opcua-file-transfer)

```js
const fileTransfer = require("node-opcua-file-transfer");

// Create a client file handle
const file = new fileTransfer.ClientFile(session, fileNodeId);

// Read a file
const handle = await file.open(fileTransfer.OpenFileMode.Read);
const data = await file.read(handle, bytesToRead);
await file.close(handle);

// Get file size
const size = await file.size();

// Write a file
const handle = await file.open(fileTransfer.OpenFileMode.Write);
await file.write(handle, Buffer.from("file contents"));
await file.close(handle);
```

---

## Extension Objects

### Construct Extension Objects from Server Schema

```js
const extensionObject = await session.constructExtensionObject(
  opcua.coerceNodeId("ns=1;i=5001"),  // DataType NodeId
  {}  // Initial values
);

// Modify fields
extensionObject.field1 = "value1";
extensionObject.field2 = 42;
```

---

## Connection Strategy & Reconnection

### Connection Strategy Options

```js
const connectionStrategy = {
  maxRetry: 10,         // Max reconnection attempts (use -1 for infinite)
  initialDelay: 1000,   // Initial delay before first retry (ms)
  maxDelay: 10000       // Maximum delay between retries (ms)
  // Delay increases exponentially: initialDelay * 2^attempt, capped at maxDelay
};
```

### Handling Reconnection Events

```js
// Fired when connection is broken and reconnection begins
client.on("start_reconnection", () => {
  console.log("Connection lost, starting reconnection...");
  // Pause interactions with server
});

// Fired during reconnection backoff
client.on("backoff", (retryCount, delay) => {
  console.log(`Reconnection attempt ${retryCount}, next in ${delay}ms`);
});

// Fired when reconnection attempt fails
client.on("reconnection_attempt_has_failed", (err, message) => {
  console.error("Reconnection attempt failed:", message);
});

// Fired when connection is restored
client.on("after_reconnection", (err) => {
  if (!err) {
    console.log("Connection re-established");
    // Resume interactions with server
  }
});

// Alias - also fires on successful reconnection
client.on("connection_reestablished", () => {
  console.log("Connection reestablished");
});

// Fired when connection is lost
client.on("connection_lost", () => {
  console.log("Connection lost");
});

// Fired when connection is closed
client.on("close", () => {
  console.log("Connection closed");
});

// Fired when connection is aborted by server
client.on("abort", () => {
  console.log("Connection aborted by server");
});

// Fired on initial connection failure
client.on("connection_failed", (err) => {
  console.error("Initial connection failed:", err.message);
});
```

---

## Error Handling Best Practices

### Always Use Try-Catch with Async Operations

```js
try {
  await client.connect(endpointUrl);
  const session = await client.createSession();
  const dataValue = await session.read({ nodeId, attributeId: 13 });
  
  if (dataValue.statusCode.isGood()) {
    // Process good data
  } else {
    // Handle bad status
    console.warn("Bad status:", dataValue.statusCode.toString());
  }
} catch (err) {
  console.error("OPC UA error:", err.message);
}
```

### Check StatusCodes on Operations

Always check status codes after read, write, and call operations:

```js
const statusCode = await session.write(writeValue);
if (!statusCode.equals(opcua.StatusCodes.Good)) {
  throw new Error(`Write failed: ${statusCode.toString()}`);
}
```

### Graceful Cleanup Pattern

```js
async function cleanup(session, client) {
  try {
    if (session) {
      await session.close(true);  // delete subscriptions
    }
  } catch (e) {
    // Session may already be closed
  }
  
  try {
    if (client) {
      await client.disconnect();
    }
  } catch (e) {
    // Client may already be disconnected
  }
}
```

### Validate Before Operations

```js
// Ensure session is valid before using it
if (session && !session.isReconnecting) {
  const result = await session.read(readRequest);
}

// Check client state before connecting
if (client && !client.isReconnecting) {
  await client.connect(endpointUrl);
}
```

---

## Client Events Reference

| Event | Parameters | Description |
|-------|-----------|-------------|
| `connected` | (none) | Initial connection succeeded |
| `connection_failed` | `(err: Error)` | Initial connection failed |
| `backoff` | `(count: number, delay: number)` | Retry backoff during reconnection |
| `start_reconnection` | (none) | Reconnection process started |
| `reconnection_attempt_has_failed` | `(err: Error, message: string)` | A reconnection attempt failed |
| `after_reconnection` | `(err?: Error)` | Reconnection completed |
| `connection_reestablished` | (none) | Connection restored |
| `connection_lost` | (none) | Connection broken |
| `close` | (none) | Connection closed |
| `abort` | (none) | Connection aborted by server |
| `timed_out_request` | `(request: Request)` | Request timed out |
| `security_token_renewed` | `(channel, token)` | Security token renewed |
| `lifetime_75` | `(token)` | Security token at 75% lifetime |
| `send_chunk` | `(chunk: Buffer)` | Message chunk sent (advanced) |
| `receive_chunk` | `(chunk: Buffer)` | Message chunk received (advanced) |
| `send_request` | `(request: Request)` | Request sent (advanced) |
| `receive_response` | `(response: Response)` | Response received (advanced) |

---

## Server Events Reference

| Event | Parameters | Description |
|-------|-----------|-------------|
| `create_session` | `(session: ServerSession)` | New session created |
| `session_activated` | `(session: ServerSession)` | Session activated |
| `session_closed` | `(session, reason: string)` | Session closed |
| `post_initialize` | (none) | Server initialized |
| `newChannel` | `(channel, endpoint)` | New secure channel opened |
| `closeChannel` | `(channel, endpoint)` | Secure channel closed |
| `connectionRefused` | `(socketData, endpoint)` | TCP connection refused |
| `openSecureChannelFailure` | `(socketData, channelData, endpoint)` | Secure channel open failed |
| `request` | `(request, channel)` | Request received (trace) |
| `response` | `(response, channel)` | Response sent (trace) |
| `event` | `(eventData)` | OPCUA event raised |
| `serverRegistered` | (none) | Registered with LDS |
| `serverRegistrationPending` | (none) | LDS registration pending |
| `serverRegistrationRenewed` | (none) | LDS registration renewed |
| `serverUnregistered` | (none) | Unregistered from LDS |

---

## Additional Tips

### Performance Optimization

- Use `session.registerNodes()` for frequently accessed nodes
- Use `ClientMonitoredItemGroup` instead of individual items when monitoring many nodes
- Choose appropriate `samplingInterval` — don't sample faster than needed
- Use typed arrays (`Float32Array`, etc.) for array data
- Set appropriate `maxNotificationsPerPublish` to batch notifications

### Common Pitfalls

1. **Don't use `new OPCUAClient()`** — always use `OPCUAClient.create(options)`
2. **Don't forget to close sessions** before disconnecting
3. **Don't assume reconnection preserves subscriptions** — re-subscribe after reconnection
4. **Always check `statusCode`** on DataValue results — a "successful" read can return bad quality data
5. **Handle `Int64` / `UInt64` carefully** — they are returned as `[high, low]` arrays, not JavaScript numbers
6. **Once disconnected, create a new client** — clients cannot reconnect after `disconnect()`
7. **Initialize server before start** — always call `server.initialize()` then `server.start()`
8. **Use `endpointMustExist: false`** when the endpoint URL may differ from server's reported URL

### NodeId String Format Reference

| Format | Example | Description |
|--------|---------|-------------|
| Numeric | `ns=0;i=2253` | Namespace + integer identifier |
| String | `ns=1;s=Temperature` | Namespace + string identifier |
| GUID | `ns=1;g=...` | Namespace + GUID |
| Opaque | `ns=1;b=...` | Namespace + Base64 ByteString |
