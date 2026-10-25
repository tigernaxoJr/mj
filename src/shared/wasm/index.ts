import { isFlowerKind, kindOf, type TileId, type TileKind } from '@/shared/kernel/types'

export interface MahjongCorePort {
  kindOf(tileId: TileId): TileKind
  isFlower(kind: TileKind): boolean
}

export const mahjongCore: MahjongCorePort = {
  kindOf,
  isFlower: isFlowerKind,
}
