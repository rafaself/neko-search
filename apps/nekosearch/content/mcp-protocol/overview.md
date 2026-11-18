# Model Context Protocol overview

The Model Context Protocol (MCP) defines a common way for an AI application to connect to context and capabilities exposed by other programs. It separates the host application, protocol client, and protocol server so one client can work with different servers through the same message model.

MCP messages use JSON-RPC 2.0. Requests have an identifier and receive a response; notifications do not expect a response. The protocol specification defines the message envelope and the features that clients and servers negotiate.

The specification snapshot represented here is `2025-11-25`. Treat the version as part of the source identity: newer revisions can change lifecycle or feature details. The official specification is available at [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-11-25).

## Core server features

- **Tools** are callable operations. A server describes each tool's name, purpose, and input schema; a client invokes it with validated arguments.
- **Resources** expose data addressed by a URI. Clients discover resources and request their contents.
- **Prompts** expose reusable prompt templates that clients can list and retrieve with arguments.

These features are distinct protocol capabilities. A server advertises the capabilities it supports during initialization, and a client should only use features that the server reports.
