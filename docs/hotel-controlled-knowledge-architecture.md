# ADR: Hotel-controlled knowledge sources and retention

**Status:** Proposed; not implemented  
**Date:** 2026-11-28  
**Scope:** Google Drive and Microsoft OneDrive / SharePoint knowledge used by Veyra

## Context

The current storage integration supports OAuth connections and imports selected file text into Veyra's `knowledge_documents` table. That imported text is then available to the normal approved-knowledge retrieval path. This is a managed-copy model, not a source-only model.

Veyra's intended customer promise is that each hotel controls its own source information and that Veyra does not quietly build a permanent copy of the hotel's knowledge. We must not advertise that promise as already delivered.

## Decision needed

Before enabling a hotel pilot, choose and clearly label one of these modes:

1. **Live-source mode (preferred default):** retain encrypted provider credentials and the minimum connection/file metadata needed to operate. Fetch the selected, authorised source content when required. Do not persist document bodies, extracted text, embeddings, or derived chunks in Veyra's database or durable object storage. Any short-lived in-process cache must have a documented TTL, bounded size, and explicit purge-on-disconnect behavior.
2. **Hotel-approved managed-copy mode (optional only):** import a selected document only after an owner/admin sees a clear explanation of what is copied, where it is stored, who can access it, how long it is retained, and how to delete it. Each imported document remains unapproved until a hotel manager reviews it. This mode must never be described as source-only or zero-retention.

Do not silently switch a hotel between modes. Record the selected mode per organization and audit changes.

## Data boundaries

- Resolve the organization from the authenticated session; never accept a caller-supplied organization ID as authority.
- Bind every provider connection, selected file, cache entry, document reference, and audit record to exactly one organization.
- Never use a global document cache keyed only by provider file ID. Cache keys must include organization, provider connection, file identity, and source version/ETag.
- Enforce tenant scope in database queries and in provider-connection lookup. A provider file ID from one hotel must not be usable with another hotel's connection.
- Store OAuth tokens encrypted with authenticated encryption. Keep client secrets server-side. Never log access tokens, refresh tokens, OAuth codes, document bodies, or signed download URLs.
- Disconnect must revoke local credentials and clear all local caches. Explain separately that the hotel may also need to revoke Veyra's grant in Google or Microsoft account settings.
- Deletion must be auditable without retaining the deleted document body.

## Model-provider boundary

Live-source mode still sends the minimum relevant excerpts to the configured AI model to draft an answer. Therefore, "Veyra never stores hotel documents" is not the same as "no third party ever processes hotel text."

Before any real hotel data is used, document and approve the model provider's data-processing terms, retention and training settings, subprocessors, region, logging controls, and applicable contractual requirements with an authorised adult/operator and the hotel. If those terms cannot support the hotel's requirements, do not send its content to that model.

## Retrieval flow for live-source mode

1. Authenticate the hotel owner/admin or guest session and resolve one organization.
2. Load only that organization's active provider connection.
3. Check that the requested source is explicitly selected and still accessible to that connection.
4. Fetch only the minimum relevant file content, enforce strict byte/type/time limits, and reject unsafe redirects or unsupported formats.
5. Keep fetched text in bounded memory only; do not write it to the knowledge tables, logs, traces, analytics, or durable cache.
6. Send only the necessary excerpt to the approved model endpoint.
7. Validate the answer against the supplied evidence and return a staff handoff when evidence is missing or ambiguous.
8. Release the transient content after the request; ensure errors and retries do not persist it.

A later indexing feature would require a separate design and explicit hotel approval. It must not be quietly introduced as an implementation detail.

## Required verification before a pilot

- Two independent test hotels connect different provider accounts and select different files.
- Cross-tenant file IDs, connection IDs, cache keys, and retrieval attempts are rejected.
- Automated tests prove live-source mode does not insert document text, embeddings, or excerpts into durable storage.
- Logs, traces, error reports, and analytics are inspected for document content and credentials.
- Disconnect, provider revocation, permission removal, file deletion, and account suspension are tested.
- Cache TTL, memory bounds, concurrency behavior, and purge-on-disconnect are tested.
- Provider API permissions are least-privilege and documented for each provider.
- Model-provider data handling is reviewed and approved before real hotel content is sent.
- Hotel staff review and approve the actual source-selection and fallback experience.

## Current implementation facts

- `storage-integrations.js` defines Google Drive and Microsoft OAuth flows and imports selected file text.
- `persistImportedKnowledge` stores the imported body in `knowledge_documents.content` and creates version-history records. The atomic-import change is in draft PR #46.
- `hotel-knowledge.js` loads approved documents scoped by `organization_id`.
- Therefore, the current implementation is a tenant-scoped managed-copy flow; it is not yet live-source-only.
- No real Google or Microsoft hotel account has been validated as part of this decision record.

## Non-goals

- This record does not implement live-source retrieval.
- It does not establish legal compliance or certify a privacy guarantee.
- It does not authorise production credentials, real guest data, paid services, or deployment.
- It does not change existing hotels' data or connection settings.

## Release gate

Keep the pilot blocked until the selected mode is implemented, its retention behavior is tested, the model-provider boundary is reviewed, and an authorised adult/operator plus the hotel approve the data-processing arrangement.
