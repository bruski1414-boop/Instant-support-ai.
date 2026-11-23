"use strict";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const COLLECTION_KEY = /^[A-Z][A-Za-z0-9]{0,79}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const MAX_PAGE_SIZE = 1000;
const MAX_PAGES = 10000;
const MAX_RECORDS = 250000;
const COMPLETE_COLLECTIONS = new WeakMap();

function cloneAndFreezeJson(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Mews returned a cyclic record; the page is invalid.");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("Mews returned a non-JSON record; the page is invalid.");
  }
  const clone = Array.isArray(value) ? [] : Object.create(null);
  seen.set(value, clone);
  for (const key of Object.keys(value)) clone[key] = cloneAndFreezeJson(value[key], seen);
  return Object.freeze(clone);
}

function validateOptions({ fetchPage, collectionKey, idField = "Id", pageSize = MAX_PAGE_SIZE, maxPages = 1000, maxRecords = MAX_RECORDS } = {}) {
  if (typeof fetchPage !== "function") throw new Error("A Mews page fetch function is required.");
  if (typeof collectionKey !== "string" || !COLLECTION_KEY.test(collectionKey)) {
    throw new Error("A valid Mews response collection key is required.");
  }
  if (typeof idField !== "string" || !FIELD_NAME.test(idField)) {
    throw new Error("A valid provider identifier field is required.");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error("Mews page size must be an integer from 1 to 1000.");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new Error("Mews maximum page count is outside the supported bound.");
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) {
    throw new Error("Mews maximum record count is outside the supported bound.");
  }
  return { fetchPage, collectionKey, idField, pageSize, maxPages, maxRecords };
}

function validatePage(response, collectionKey, idField, pageSize, seenIds, items, maxRecords, seenCursors) {
  if (!response || typeof response !== "object" || Array.isArray(response) ||
      !Object.hasOwn(response, collectionKey) || !Array.isArray(response[collectionKey]) ||
      !Object.hasOwn(response, "Cursor")) {
    throw new Error("Mews returned an incomplete cursor page; the collection cannot be treated as complete.");
  }

  const rows = response[collectionKey];
  if (rows.length > pageSize) throw new Error("Mews returned more records than the requested page size.");

  const nextCursor = response.Cursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !SAFE_ID.test(nextCursor))) {
    throw new Error("Mews returned an invalid pagination cursor.");
  }

  if (rows.length === 0) {
    if (nextCursor !== null) throw new Error("Mews returned a cursor without a corresponding final record.");
    return null;
  }
  if (nextCursor === null) {
    throw new Error("Mews returned records without the required continuation cursor.");
  }

  let lastId = null;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        !Object.hasOwn(row, idField) || typeof row[idField] !== "string" ||
        !SAFE_ID.test(row[idField])) {
      throw new Error("Mews returned a record without a valid opaque identifier.");
    }
    const id = row[idField];
    if (seenIds.has(id)) throw new Error("Mews cursor pagination returned a duplicate record identifier.");
    if (items.length >= maxRecords) throw new Error("Mews pagination exceeded the configured record safety limit.");
    seenIds.add(id);
    items.push(cloneAndFreezeJson(row));
    lastId = id;
  }

  if (nextCursor !== lastId) {
    throw new Error("Mews pagination cursor did not identify the last record in the page.");
  }
  if (seenCursors.has(nextCursor)) {
    throw new Error("Mews pagination cursor repeated; complete coverage cannot be established.");
  }
  seenCursors.add(nextCursor);
  return nextCursor;
}

async function collectMewsCursorPages(options = {}) {
  const config = validateOptions(options);
  const items = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let pageCount = 0;

  while (true) {
    if (pageCount >= config.maxPages) {
      throw new Error("Mews pagination exceeded the configured page safety limit; results are incomplete.");
    }

    let response;
    try {
      response = await config.fetchPage(Object.freeze({ cursor, count: config.pageSize }));
    } catch {
      throw new Error("Mews cursor page request failed; results are incomplete.");
    }

    const nextCursor = validatePage(
      response,
      config.collectionKey,
      config.idField,
      config.pageSize,
      seenIds,
      items,
      config.maxRecords,
      seenCursors
    );
    pageCount += 1;
    if (nextCursor === null) break;
    cursor = nextCursor;
  }

  const collection = Object.freeze({
    collectionKey: config.collectionKey,
    items: Object.freeze(items.slice()),
    pageCount,
    recordCount: items.length,
    complete: true
  });
  COMPLETE_COLLECTIONS.set(collection, Object.freeze({
    collectionKey: config.collectionKey,
    pageCount,
    recordCount: items.length
  }));
  return collection;
}

function isCompleteMewsPageCollection(value, expectedCollectionKey) {
  const metadata = value && typeof value === "object" ? COMPLETE_COLLECTIONS.get(value) : null;
  return Boolean(metadata && (!expectedCollectionKey || metadata.collectionKey === expectedCollectionKey) &&
    Array.isArray(value.items) && value.items.length === metadata.recordCount &&
    value.complete === true);
}

module.exports = {
  collectMewsCursorPages,
  isCompleteMewsPageCollection,
  MAX_PAGE_SIZE
};
