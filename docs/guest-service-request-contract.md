# Guest contact capture and buggy transport request contract

Status: **validated request contract only**. This is not a live Shebara integration.

## Purpose

Veyra may collect the minimum contact and journey details needed to pass a guest's buggy request to the hotel's authorised transport team. The guest must explicitly consent before their name and phone number are included.

## Contract

`guest-service-request.js` exports `buildBuggyServiceRequest(input)`. It validates:
- full name (at least two words);
- phone number in international E.164 format;
- explicit `consentToShareDetails: true`;
- passenger count from 1 to 20;
- pickup and drop-off locations;
- requested date/time with an explicit timezone.

It returns a `request_pending` payload with `confirmationRequired: true` and `providerWritePerformed: false`.

## Non-negotiable behaviour

- A pending request is not a reservation.
- Veyra must not tell a guest a buggy is booked until the hotel's transport provider returns a verified confirmation/reference.
- Availability must come from the live, hotel-authorised transport system; stale or missing availability means staff handoff.
- Never put guest contact details in application logs, analytics events, webhook URLs, or model prompts unless the hotel has explicitly approved that data flow.
- Store and transmit contact details only after the hotel's privacy notice, consent wording, retention policy and secure data path have been approved.
- Do not accept card details or payment credentials in chat.
- Staff handoff must identify the hotel workspace and use an idempotency key so retries cannot create duplicate transport requests.

## Remaining integration blockers

1. Shebara's actual PMS and transport/buggy dispatch provider are not yet confirmed.
2. The hotel must provide written authorisation and vendor-approved sandbox credentials/scopes.
3. The provider must document a create-request/reservation operation, availability lookup, cancellation/change behaviour, and confirmation identifier.
4. A hotel operator must approve guest consent wording, retention period, staff workflow and escalation destination.
5. End-to-end tests must prove availability, booking, duplicate retry handling, cancellation, time-zone correctness and tenant isolation before guest-facing activation.

The existing Mews client in this branch is explicitly read-only and restricted to the Mews demo host. It cannot currently create a buggy reservation or write a guest profile. Do not remove that restriction or send production requests until the hotel and provider approve the integration.
