import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repoDirNameFromUrl } from './layerFs.mjs';

describe('repoDirNameFromUrl', () => {
  it('parses https clone URLs', () => {
    assert.equal(repoDirNameFromUrl('https://github.com/acme/somanyad.git'), 'somanyad');
    assert.equal(repoDirNameFromUrl('https://github.com/acme/somanyad-emailD.git'), 'somanyad-emailD');
  });

  it('parses SCP-style git@host:path URLs (not WHATWG URL)', () => {
    assert.equal(
      repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad.git'),
      'somanyad',
    );
    assert.equal(
      repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad-emailD.git'),
      'somanyad-emailD',
    );
  });

  it('does not collapse distinct SCP repos to the same default name', () => {
    const a = repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad.git');
    const b = repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad-emailD.git');
    assert.notEqual(a, b);
    assert.notEqual(a, 'repo');
    assert.notEqual(b, 'repo');
  });
});
