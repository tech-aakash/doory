import { FabricImage, Group, Rect } from 'fabric'
import { createBlankDocument } from '@/lib/document'
import type { AssetRef } from '@/types/adapter'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { installImageStub } from '../test/imageStub'
import { EditorEngine } from './editor'
import { asDory } from './objects/dory'
import { gridCellObject, imageGridSpecOf, isEmptyGridCell } from './objects/imageGrid'
import { kindOfLive } from './objects/kinds'

interface TestEditor {
  engine: EditorEngine
  pageId: string
  view: NonNullable<ReturnType<EditorEngine['activeView']>>
}

const editors: EditorEngine[] = []
let restoreImages: (() => void) | null = null

async function setup(doc = createBlankDocument(800, 600)): Promise<TestEditor> {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd1', title: 'Grid test', mode: 'guest' }, ephemeral: true })
  editors.push(engine)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  return { engine, pageId, view }
}

function selectedGrid(editor: TestEditor): Group {
  const selected = editor.view.selectedObjects()[0]
  expect(selected).toBeInstanceOf(Group)
  expect(kindOfLive(selected)).toBe('image-grid')
  return selected as Group
}

async function asset(engine: EditorEngine, name: string): Promise<AssetRef> {
  return engine.assets.upload(new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }), name)
}

async function insertPhoto(editor: TestEditor, name: string, at: { x: number; y: number }): Promise<FabricImage> {
  await editor.engine.insert.imageFromAsset(await asset(editor.engine, name), at, editor.pageId)
  const photo = editor.view.selectedObjects()[0]
  expect(photo).toBeInstanceOf(FabricImage)
  return photo as FabricImage
}

beforeEach(() => {
  restoreImages = installImageStub({ width: 600, height: 300 })
  vi.spyOn(FabricImage.prototype, '_render').mockImplementation(() => undefined)
  URL.createObjectURL = vi.fn(() => 'blob:grid-test')
})

afterEach(async () => {
  for (const engine of editors.splice(0)) engine.dispose()
  await new Promise((resolve) => setTimeout(resolve, 40))
  vi.restoreAllMocks()
  restoreImages?.()
  restoreImages = null
  document.body.innerHTML = ''
})

describe('image grids', () => {
  it('inserts a semantic group with transparent layout-owned cells', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('feature-left')

    const grid = selectedGrid(editor)
    expect(imageGridSpecOf(grid)).toMatchObject({ version: 1, layoutId: 'feature-left', gap: 8 })
    expect(grid.getObjects()).toHaveLength(3)
    for (const child of grid.getObjects()) {
      expect(child).toBeInstanceOf(Rect)
      expect(isEmptyGridCell(child)).toBe(true)
      expect(child.fill).toBe('transparent')
      expect(asDory(child).isPlaceholder).toBeUndefined()
    }
    expect(editor.engine.state.doc.pages[0].objects[0]).toMatchObject({ type: 'group', imageGrid: { layoutId: 'feature-left' } })
  })

  it('round-trips through document JSON and gives duplicates fresh object ids', async () => {
    const first = await setup()
    await first.engine.imageGrids.insert('four-grid')
    const original = selectedGrid(first)
    const originalIds = [asDory(original).id, ...original.getObjects().map((child) => asDory(child).id)]
    const saved = structuredClone(first.engine.getDocument())

    const reopened = await setup(saved)
    const restored = reopened.view.canvas.getObjects()[0]
    expect(restored).toBeInstanceOf(Group)
    expect(kindOfLive(restored)).toBe('image-grid')
    expect(imageGridSpecOf(restored)?.layoutId).toBe('four-grid')

    reopened.view.selectObjects([restored])
    reopened.engine.refreshSelection()
    await reopened.engine.arrange.duplicate()
    const duplicate = selectedGrid(reopened)
    const duplicateIds = [asDory(duplicate).id, ...duplicate.getObjects().map((child) => asDory(child).id)]
    expect(duplicateIds).toHaveLength(originalIds.length)
    expect(duplicateIds.every((id) => !!id && !originalIds.includes(id))).toBe(true)
    expect(imageGridSpecOf(duplicate)).toEqual(imageGridSpecOf(restored))
  })

  it('fills and replaces a cell while retaining its stable cell identity', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('two-columns')
    const grid = selectedGrid(editor)
    const gridId = asDory(grid).id!
    const emptyId = asDory(gridCellObject(grid, 'cell-1')!).id

    await editor.engine.imageGrids.fillCellWith(editor.pageId, gridId, 'cell-1', await asset(editor.engine, 'first.png'))
    const first = gridCellObject(grid, 'cell-1')
    expect(first).toBeInstanceOf(FabricImage)
    expect(asDory(first!).id).toBe(emptyId)
    expect(asDory(first!).docSrc).toContain('idb://')
    expect((first as FabricImage).scaleX).toBeCloseTo((first as FabricImage).scaleY)

    await editor.engine.imageGrids.fillCellWith(editor.pageId, gridId, 'cell-1', await asset(editor.engine, 'replacement.png'))
    const replacement = gridCellObject(grid, 'cell-1')
    expect(replacement).toBeInstanceOf(FabricImage)
    expect(asDory(replacement!).id).toBe(emptyId)
    expect(asDory(replacement!).name).toBe('replacement.png')
    expect(grid.getObjects()).toHaveLength(2)
  })

  it('changes layouts when removed cells are empty, refuses image loss and applies gaps', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('two-columns')
    const grid = selectedGrid(editor)

    await editor.engine.imageGrids.setLayout('feature-left')
    expect(imageGridSpecOf(grid)?.layoutId).toBe('feature-left')
    expect(grid.getObjects()).toHaveLength(3)

    await editor.engine.imageGrids.setLayout('two-rows')
    expect(imageGridSpecOf(grid)?.layoutId).toBe('two-rows')
    expect(grid.getObjects()).toHaveLength(2)

    await editor.engine.imageGrids.setLayout('feature-left')
    await editor.engine.imageGrids.fillCellWith(editor.pageId, asDory(grid).id!, 'cell-3', await asset(editor.engine, 'third.png'))
    await editor.engine.imageGrids.setLayout('two-rows')
    expect(imageGridSpecOf(grid)?.layoutId).toBe('feature-left')
    expect(grid.getObjects()).toHaveLength(3)

    await editor.engine.imageGrids.setGap(24)
    expect(imageGridSpecOf(grid)?.gap).toBe(24)
    expect(grid.scaleX).toBeCloseTo(1)
    expect(grid.scaleY).toBeCloseTo(1)
  })

  it('bakes independent size changes and keeps every photo uniformly scaled', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('two-columns')
    const grid = selectedGrid(editor)
    await editor.engine.imageGrids.fillCellWith(editor.pageId, asDory(grid).id!, 'cell-1', await asset(editor.engine, 'wide.png'))

    editor.engine.arrange.setSize(500, 180)
    const photo = gridCellObject(grid, 'cell-1') as FabricImage
    expect(grid.width).toBeCloseTo(500)
    expect(grid.height).toBeCloseTo(180)
    expect(grid.scaleX).toBeCloseTo(1)
    expect(grid.scaleY).toBeCloseTo(1)
    expect(photo.scaleX).toBeCloseTo(photo.scaleY)
    expect(photo.getScaledWidth()).toBeCloseTo(246)
    expect(photo.getScaledHeight()).toBeCloseTo(180)
  })

  it('swaps image content and clears a cell without creating exportable placeholders', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('two-columns')
    const grid = selectedGrid(editor)
    const gridId = asDory(grid).id!
    await editor.engine.imageGrids.fillCellWith(editor.pageId, gridId, 'cell-1', await asset(editor.engine, 'one.png'))
    await editor.engine.imageGrids.fillCellWith(editor.pageId, gridId, 'cell-2', await asset(editor.engine, 'two.png'))
    const one = asDory(gridCellObject(grid, 'cell-1')!).docSrc
    const two = asDory(gridCellObject(grid, 'cell-2')!).docSrc

    editor.engine.imageGrids.swapCells(editor.pageId, gridId, 'cell-1', 'cell-2')
    expect(asDory(gridCellObject(grid, 'cell-1')!).docSrc).toBe(two)
    expect(asDory(gridCellObject(grid, 'cell-2')!).docSrc).toBe(one)

    await editor.engine.imageGrids.clearCell('cell-2')
    const empty = gridCellObject(grid, 'cell-2')
    expect(empty).toBeInstanceOf(Rect)
    expect(empty?.fill).toBe('transparent')
    expect(asDory(empty!).isPlaceholder).toBeUndefined()
    const storedChildren = editor.engine.state.doc.pages[0].objects[0].objects as Array<Record<string, unknown>>
    expect(storedChildren.find((child) => child.gridCellId === 'cell-2')).toMatchObject({ fill: 'transparent' })
    expect(storedChildren.some((child) => child.isPlaceholder === true)).toBe(false)
  })

  it('moves a canvas image into an empty cell and restores it through undo and redo', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('two-columns')
    const grid = selectedGrid(editor)
    const gridId = asDory(grid).id!
    const photo = await insertPhoto(editor, 'source.png', { x: 160, y: 140 })
    const photoId = asDory(photo).id!
    const center = photo.getCenterPoint()
    const frame = {
      center: { x: center.x, y: center.y },
      width: photo.getScaledWidth(),
      height: photo.getScaledHeight(),
      angle: photo.angle || 0,
      flipX: photo.flipX,
      flipY: photo.flipY,
    }

    editor.engine.imageGrids.consumeCanvasImage(editor.pageId, photoId, gridId, 'cell-1', frame)
    expect(editor.view.canvas.getObjects()).toEqual([grid])
    expect(gridCellObject(grid, 'cell-1')).toBe(photo)
    expect(asDory(photo).gridCellId).toBe('cell-1')

    await editor.engine.undo()
    const restoredGrid = editor.view.getById(gridId) as Group
    const restoredPhoto = editor.view.getById(photoId) as FabricImage
    expect(restoredGrid).toBeInstanceOf(Group)
    expect(restoredPhoto).toBeInstanceOf(FabricImage)
    expect(isEmptyGridCell(gridCellObject(restoredGrid, 'cell-1'))).toBe(true)
    expect(restoredPhoto.getCenterPoint().x).toBeCloseTo(frame.center.x)
    expect(restoredPhoto.getCenterPoint().y).toBeCloseTo(frame.center.y)

    await editor.engine.redo()
    const redoneGrid = editor.view.getById(gridId) as Group
    expect(editor.view.getById(photoId)).toBeUndefined()
    expect(asDory(gridCellObject(redoneGrid, 'cell-1')!).id).toBe(photoId)
  })

  it('returns an occupied cell photo to the source frame when a canvas image replaces it', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('two-columns')
    const grid = selectedGrid(editor)
    const gridId = asDory(grid).id!
    await editor.engine.imageGrids.fillCellWith(editor.pageId, gridId, 'cell-1', await asset(editor.engine, 'displaced.png'))
    const displaced = gridCellObject(grid, 'cell-1') as FabricImage
    const displacedId = asDory(displaced).id!
    const source = await insertPhoto(editor, 'replacement.png', { x: 180, y: 150 })
    const sourceId = asDory(source).id!
    const center = source.getCenterPoint()
    const frame = {
      center: { x: center.x, y: center.y },
      width: source.getScaledWidth(),
      height: source.getScaledHeight(),
      angle: source.angle || 0,
      flipX: source.flipX,
      flipY: source.flipY,
    }

    editor.engine.imageGrids.consumeCanvasImage(editor.pageId, sourceId, gridId, 'cell-1', frame)

    expect(gridCellObject(grid, 'cell-1')).toBe(source)
    expect(asDory(source).gridCellId).toBe('cell-1')
    expect(editor.view.getById(displacedId)).toBe(displaced)
    expect(asDory(displaced).gridCellId).toBeUndefined()
    expect(displaced.getCenterPoint().x).toBeCloseTo(frame.center.x)
    expect(displaced.getCenterPoint().y).toBeCloseTo(frame.center.y)
    expect(displaced.getScaledWidth()).toBeCloseTo(frame.width)
    expect(displaced.getScaledHeight()).toBeCloseTo(frame.height)
  })

  it('does not consume specialised or masked canvas images', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('two-columns')
    const grid = selectedGrid(editor)
    const gridId = asDory(grid).id!
    const source = await insertPhoto(editor, 'source.png', { x: 180, y: 150 })
    const sourceId = asDory(source).id!
    const center = source.getCenterPoint()
    const frame = {
      center: { x: center.x, y: center.y },
      width: source.getScaledWidth(),
      height: source.getScaledHeight(),
      angle: 0,
      flipX: false,
      flipY: false,
    }

    asDory(source).qr = { text: 'https://example.com', fg: '#000000', bg: '#ffffff' }
    editor.engine.imageGrids.consumeCanvasImage(editor.pageId, sourceId, gridId, 'cell-1', frame)
    expect(editor.view.getById(sourceId)).toBe(source)
    expect(isEmptyGridCell(gridCellObject(grid, 'cell-1'))).toBe(true)

    delete asDory(source).qr
    asDory(source).maskShape = 'circle'
    editor.engine.imageGrids.consumeCanvasImage(editor.pageId, sourceId, gridId, 'cell-1', frame)
    expect(editor.view.getById(sourceId)).toBe(source)
    expect(isEmptyGridCell(gridCellObject(grid, 'cell-1'))).toBe(true)
  })

  it('leaves grids unchanged when the editor is read-only', async () => {
    const editor = await setup()
    await editor.engine.imageGrids.insert('feature-left')
    const grid = selectedGrid(editor)
    const gridId = asDory(grid).id!
    editor.engine.setLiveReadOnly(true)

    await editor.engine.imageGrids.setGap(24)
    await editor.engine.imageGrids.setLayout('two-columns')
    editor.engine.imageGrids.swapCells(editor.pageId, gridId, 'cell-1', 'cell-2')

    expect(imageGridSpecOf(grid)).toMatchObject({ layoutId: 'feature-left', gap: 8 })
    expect(grid.getObjects()).toHaveLength(3)
  })
})
