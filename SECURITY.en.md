[繁體中文](SECURITY.md) | **English**

# Security policy

## Supported versions

Only the latest version on the `main` branch is maintained.

## Reporting a vulnerability

Please do not report security problems in a public issue.

Use **Security → Report a vulnerability** on the project's GitHub page. If that option is not available, open an issue titled "Request for a private contact", **without** any vulnerability details, and the maintainer will get in touch.

Where possible, include:

- The affected file or feature
- Steps to reproduce or a proof of concept
- The potential impact

The maintainer will acknowledge the report and assess it as soon as possible. Please keep the details private until a fix is released.

## Scope

The following is expected behaviour, not a vulnerability:

- With "Allow editing files and running commands" enabled for a member, the AI CLI creating, modifying or deleting files and running commands inside the working directory.
- Extensions installed by the user running commands with the user's account permissions; JS plugins have full Node.js access.
- Conversation content and attachments being sent through the CLIs or APIs the user configured.

Reports of the following are welcome:

- The renderer or conversation content causing the main process to read or write files outside what is intended (for example bypassing the path checks for history, attachments or extensions)
- Commands running or extensions loading without a user action
- API keys written to disk or logs in plain text, or passed to the renderer
- Attachment validation being bypassed to read or overwrite files outside the working directory

## Recommendations

- Use a dedicated folder under git as the working directory; do not point it at your home directory or an important project.
- Only install extensions you can read and trust.
- Enter API keys in the extension editor (encrypted with the operating system's secure storage) or use environment variables; do not write them into extension files.
