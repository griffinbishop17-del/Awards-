'use strict';
// Loads and validates config/awards.js, resolves nominee photos, and exposes
// lookup helpers used by voting logic and the results dashboard.

const fs = require('fs');
const path = require('path');
const { people, categories } = require('../config/awards');

const IMG_DIR = path.join(__dirname, '..', 'public', 'img', 'nominees');
const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function findImage(id) {
  for (const ext of IMG_EXTS) {
    if (fs.existsSync(path.join(IMG_DIR, `${id}.${ext}`))) return `/img/nominees/${id}.${ext}`;
  }
  return null;
}

function build() {
  const seenCats = new Set();
  const out = categories.map((cat) => {
    if (!ID_RE.test(cat.id)) throw new Error(`Invalid category id: ${cat.id}`);
    if (seenCats.has(cat.id)) throw new Error(`Duplicate category id: ${cat.id}`);
    seenCats.add(cat.id);
    if (!Array.isArray(cat.nominees) || cat.nominees.length < 2) {
      throw new Error(`Category "${cat.name}" needs at least 2 nominees`);
    }
    if (new Set(cat.nominees).size !== cat.nominees.length) {
      throw new Error(`Category "${cat.name}" lists a nominee twice`);
    }
    return {
      id: cat.id,
      name: cat.name,
      blurb: cat.blurb || '',
      nominees: cat.nominees.map((pid) => {
        const p = people[pid];
        if (!p) throw new Error(`Category "${cat.name}" references unknown person "${pid}"`);
        if (!ID_RE.test(pid)) throw new Error(`Invalid person id: ${pid}`);
        return { id: pid, name: p.name, image: p.image || findImage(pid) };
      }),
    };
  });
  return out;
}

const CATEGORIES = build();
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, new Set(c.nominees.map((n) => n.id))]));

/**
 * Validate a ballot's choices. Returns { ok: true, choices } with a clean
 * {categoryId: nomineeId} map, or { ok: false, error }.
 */
function validateChoices(choices) {
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) {
    return { ok: false, error: 'Your ballot was not in the expected format.' };
  }
  const keys = Object.keys(choices);
  for (const k of keys) {
    if (!BY_ID.has(k)) return { ok: false, error: 'Your ballot contains an unknown category.' };
  }
  const clean = {};
  const missing = [];
  for (const cat of CATEGORIES) {
    const v = choices[cat.id];
    if (v === undefined || v === null || v === '') {
      missing.push(cat.name);
      continue;
    }
    if (typeof v !== 'string' || !BY_ID.get(cat.id).has(v)) {
      return { ok: false, error: `That choice isn't a valid nominee for ${cat.name}.` };
    }
    clean[cat.id] = v;
  }
  if (missing.length) {
    return { ok: false, error: `Please pick a nominee in every category. Still needed: ${missing.join(', ')}.`, missing };
  }
  return { ok: true, choices: clean };
}

module.exports = { CATEGORIES, validateChoices };
