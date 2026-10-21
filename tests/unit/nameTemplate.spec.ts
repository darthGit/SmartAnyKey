// A name template fills the selected hosts in
// selection order, and never overwrites a name the admin typed by hand.
import { describe, expect, it } from 'vitest'
import { fillNames } from '../../app/utils/nameTemplate'

describe('fillNames', () => {
  it('numbers the selected hosts in order', () => {
    expect(fillNames('Каса {n}', ['a', 'b', 'c'], {}, new Set())).toEqual({ a: 'Каса 1', b: 'Каса 2', c: 'Каса 3' })
  })

  it('keeps a hand-edited name and does not spend its number', () => {
    const out = fillNames('Каса {n}', ['a', 'b', 'c'], { b: 'Каса головна' }, new Set(['b']))
    expect(out).toEqual({ a: 'Каса 1', b: 'Каса головна', c: 'Каса 2' })
  })

  it('without {n} several hosts still get distinct names', () => {
    expect(fillNames('Каса', ['a', 'b'], {}, new Set())).toEqual({ a: 'Каса 1', b: 'Каса 2' })
    expect(fillNames('Каса', ['a'], {}, new Set())).toEqual({ a: 'Каса' })
  })

  it('leaves unselected names alone', () => {
    expect(fillNames('X{n}', ['a'], { z: 'keep' }, new Set())).toEqual({ a: 'X1', z: 'keep' })
  })
})
