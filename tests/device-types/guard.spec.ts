// RED (deleting an unused type; deleting a used one → 409 with count). The business
// logic of the delete guard lives in the service; the repo is mocked (3-Tier). Module
// server/services/device-types.ts does not exist yet → fails.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { countDevicesOfType, deleteType } = vi.hoisted(() => ({
  countDevicesOfType: vi.fn(), deleteType: vi.fn(),
}))
vi.mock('../../server/repositories/device-types', () => ({ countDevicesOfType, deleteType }))

const { removeTypeGuarded } = await import('../../server/services/device-types')
const sr = {} as never

beforeEach(() => {
  countDevicesOfType.mockReset()
  deleteType.mockReset()
})

describe('removeTypeGuarded', () => {
  it('AC-6: a type without devices → calls deleteType', async () => {
    countDevicesOfType.mockResolvedValue(0)
    await removeTypeGuarded(sr, 't1')
    expect(deleteType).toHaveBeenCalledWith(sr, 't1')
  })

  it('AC-7: a type with N devices → 409 with count, deleteType is NOT called', async () => {
    countDevicesOfType.mockResolvedValue(3)
    await expect(removeTypeGuarded(sr, 't1')).rejects.toMatchObject({ statusCode: 409, data: { count: 3 } })
    expect(deleteType).not.toHaveBeenCalled()
  })
})
