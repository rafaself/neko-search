# MCP architecture

MCP separates an application that uses model capabilities from the servers that provide context or actions. The host owns the user experience and model interaction. It creates a protocol client for each server connection. A server exposes a focused set of capabilities through that client connection.

The client and server exchange JSON-RPC messages through a transport. Request and response identifiers correlate replies with requests. Notifications carry events such as capability changes without creating a response obligation.

## Capability ownership

Servers provide tools, resources, and prompts. Clients discover and call those server features. Clients may also advertise capabilities of their own, such as roots or sampling, which let a server request host-provided context or model assistance when the feature is negotiated.

The protocol does not require a host to expose every connected server to a model. Hosts can apply user consent, access controls, and policy before forwarding a tool call or sharing client-provided context.

For the versioned message rules and capability definitions, see the [2025-11-25 specification](https://modelcontextprotocol.io/specification/2025-11-25).
