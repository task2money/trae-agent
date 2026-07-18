import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyLayerParentDiffPagination } from './layerParentDiff.mjs'

describe('applyLayerParentDiffPagination', () => {
  const base = {
    layer_id: 'L1',
    parent_layer_id: 'P1',
    same: false,
    truncated: false,
    detail: '',
    changes: [
      { path: 'a.js', kind: 'added' },
      { path: 'b.js', kind: 'modified' },
      { path: 'c.js', kind: 'removed' },
    ],
  }

  it('returns full list when limit omitted', () => {
    const out = applyLayerParentDiffPagination(base, {})
    assert.equal(out.changes.length, 3)
    assert.equal(out.change_count, 3)
    assert.equal(out.has_more, false)
    assert.equal(out.next_offset, 3)
  })

  it('pages with offset and limit', () => {
    const out = applyLayerParentDiffPagination(base, { offset: 1, limit: 1 })
    assert.deepEqual(
      out.changes.map((c) => c.path),
      ['b.js'],
    )
    assert.equal(out.change_count, 3)
    assert.equal(out.offset, 1)
    assert.equal(out.next_offset, 2)
    assert.equal(out.has_more, true)
  })

  it('has_more false on last page', () => {
    const out = applyLayerParentDiffPagination(base, { offset: 2, limit: 10 })
    assert.equal(out.changes.length, 1)
    assert.equal(out.has_more, false)
    assert.equal(out.next_offset, 3)
  })
})
