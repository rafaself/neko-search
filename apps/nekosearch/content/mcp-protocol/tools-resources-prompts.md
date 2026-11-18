# Tools, resources, and prompts

MCP servers can expose three complementary kinds of features.

## Tools

Tools let a client request an operation by name with structured arguments. A tool definition includes an input schema and descriptive metadata. The host remains responsible for deciding whether to make a tool available and whether a call needs user approval. Servers should validate arguments and report tool failures distinctly from JSON-RPC protocol failures.

## Resources

Resources are data identified by URIs. A client can list resources and read their contents; resource templates let a server describe URI patterns that accept variables. Resources are a data access interface, while tools represent operations.

## Prompts

Prompts are reusable templates with named arguments. Clients can discover them and request a rendered prompt for a particular use. They help a server offer task-specific guidance without conflating that guidance with a tool call or resource read.

Feature availability depends on the capabilities negotiated for the connection. Refer to the official [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), and [prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts) sections for the normative definitions.
