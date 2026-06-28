// Pure unit tests for the inbound role-routing helpers (used by `seal pull`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleForSection, personForRole } from '../skills/seal-review/scripts/seal.mjs';

test('roleForSection prefers an EXACT heading match over containment', () => {
  const roles = [
    { role: 'Finance', relevant_sections: ['Cost Overview'] }, // contains "Overview"
    { role: 'PM', relevant_sections: ['Overview'] },           // exact
  ];
  assert.equal(roleForSection(roles, 'Overview'), 'PM');
});

test('roleForSection falls back to containment when no exact match', () => {
  const roles = [{ role: 'Legal', relevant_sections: [{ section: 'Data Retention Policy' }] }];
  assert.equal(roleForSection(roles, 'Retention'), 'Legal');
  assert.equal(roleForSection(roles, 'Nonexistent'), null);
});

test('personForRole matches a curated role field and returns the email', () => {
  const people = { 'Lee Legal': { role: 'Legal', email: 'lee@law.example' }, '_meta': { ignore: true } };
  assert.deepEqual(personForRole(people, 'Legal'), { name: 'Lee Legal', email: 'lee@law.example' });
  assert.equal(personForRole(people, 'Engineering'), null);
  assert.equal(personForRole(people, null), null);
});
