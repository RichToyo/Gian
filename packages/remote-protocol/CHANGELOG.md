# Remote Protocol package

## [1.4.0]

- Adds conversation translation under the new `wire.conversation_translation`
  capability: a minimal display DTO (`remoteTranslationSchema`), per-session
  small state with ordered versions — a monotonic `revision` for the switch,
  a Host-wide `config_revision` for saved preferences, and an
  `automatic_revision`/`automatic_epoch` pair shared by wholesale states and
  live deltas (deltas advance the view's version; stale snapshots or
  ledger-replayed results never resurrect a settled pending row, and a
  retired Host epoch never rolls back the adopted one) — the `translation.state` / `translation.set_auto` /
  `translation.request` / `translation.cancel` / `translation.result_text` /
  `translation.request_status` commands, a gated optional `translation_id`
  receipt on `session.send`, sent-translation summaries on user transcript
  items, reading translations on transcript pages, and `translation.updated`
  events. Texts larger than the wire bound ship as descriptors
  (`text_length` + `text_sha256`) paged in full through
  `translation.result_text` — a prefix is never presented as complete.
  Request outcomes are recoverable by request identity
  (`translation.request_status`), so a lost settle event leaves no permanent
  pending state. Hosts send every new field, event kind and command response
  only to connections that negotiated the capability; legacy (no-hello) and
  non-negotiated peers receive byte-identical frames. The DTO deliberately
  omits Agent/model configuration, Composer documents, local paths and
  provider errors.
- Hello negotiation maximum minor version is now 3 (minimum stays 1).
- Backward compatible with 1.3.0 peers: no existing schema, method or
  capability shape changed.

## [1.3.0]

- Adds an optional `host.locale` field to state snapshots so Remote Web can
  follow the Host's configured UI language (`en` / `zh-CN`). Hosts send it
  only to connections that negotiated the new `wire.host_locale` capability;
  closed-schema peers never receive the field, and new clients treat a
  missing locale as `en`.
- Hello negotiation maximum minor version is now 2 (minimum stays 1): legacy
  and minor-1 connections are unchanged.
- Backward compatible with 1.2.0 peers: no existing schema, method or
  capability shape changed.

## [1.2.0]

- Adds verified GitHub account admission schemas and account-bound Host enrollment.
  Enrollment tokens expire after five minutes and may only be consumed once.
- Adds local-Session/remote-execution commands, durable execution history,
  takeover, catalog/configuration contracts, scoped file previews and read-only Git.
- Publishes the reusable encrypted controller client and transport helpers.
- Native execution requires the negotiated `wire.execution_v1` capability and
  same-account authentication. Deploy compatible Server, Web and Gian clients;
  legacy unbound Host credentials do not bypass the new account gate.

## [1.1.0]

- Adds the read-only `proxy.logo` command method: closed params (`proxy` name + `light`/`dark` variant) and result (`media_type`, `data_base64` ≤ 128 KiB raw, `sha256`) schemas so Remote clients can render Proxy branding logos without Host HTTP access.
- Adds the `RESOURCE_NOT_FOUND` error code. Hosts predating the method reject it as `INVALID_FRAME`, so mixed-version peers keep working.
- Backward compatible with 1.0.0 peers: no existing schema, method or capability shape changed.

## [1.0.0]

- Initial standalone `@gian/remote-protocol` package distributed through public Gian GitHub Releases.
- Includes compiled JavaScript and TypeScript declarations for Remote authentication, relay, business messages, cryptography and hello negotiation.
- Pins the runtime dependencies used to qualify the package; consumers can install its release archive without accessing GianDev or copying protocol source.
- Package versioning is independent of Gian Desktop, Gian Remote and wire-protocol revisions.
