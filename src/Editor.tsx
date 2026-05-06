/* eslint-disable jsx-a11y/click-events-have-key-events */
/* eslint-disable jsx-a11y/no-static-element-interactions */
import { ViewBoardsIcon } from '@heroicons/react/outline'
import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import { useWindowSize } from 'react-use'
import inpaint from './adapters/inpainting'
import superResolution from './adapters/superResolution'
import Button from './components/Button'
import FileSelect from './components/FileSelect'
import Slider from './components/Slider'
import { downloadImage, loadImage, useImage } from './utils'
import Progress from './components/Progress'
import { modelExists, downloadModel } from './adapters/cache'
import Modal from './components/Modal'
import * as m from './paraglide/messages'

interface EditorProps {
  file?: File
  onFileSelection: (file: File) => void | Promise<void>
  onReset: () => void
}

type ToolMode = 'brush' | 'eraser'

interface Line {
  size?: number
  pts: { x: number; y: number }[]
  mode: ToolMode
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: Line[],
  color = 'rgba(47, 140, 255, 0.45)'
) {
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  lines.forEach(line => {
    if (!line?.pts.length || !line.size) {
      return
    }
    ctx.save()
    if (line.mode === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0, 0, 0, 1)'
    } else {
      ctx.strokeStyle = color
    }
    ctx.lineWidth = line.size
    ctx.beginPath()
    ctx.moveTo(line.pts[0].x, line.pts[0].y)
    line.pts.forEach(pt => ctx.lineTo(pt.x, pt.y))
    ctx.stroke()
    ctx.restore()
  })
}

const BRUSH_HIDE_ON_SLIDER_CHANGE_TIMEOUT = 2000
export default function Editor(props: EditorProps) {
  const { file, onFileSelection, onReset } = props
  const [brushSize, setBrushSize] = useState(40)
  const [original, isOriginalLoaded] = useImage(file)
  const [renders, setRenders] = useState<HTMLImageElement[]>([])
  const [context, setContext] = useState<CanvasRenderingContext2D>()
  const [maskCanvas] = useState<HTMLCanvasElement>(() => {
    return document.createElement('canvas')
  })
  const [pendingLines, setPendingLines] = useState<Line[]>([])
  const [redoRenders, setRedoRenders] = useState<HTMLImageElement[]>([])
  const [redoPendingLines, setRedoPendingLines] = useState<Line[]>([])
  const [toolMode, setToolMode] = useState<ToolMode>('brush')
  const brushRef = useRef<HTMLDivElement>(null)
  const [showBrush, setShowBrush] = useState(false)
  const [hideBrushTimeout, setHideBrushTimeout] = useState(0)
  const [showOriginal, setShowOriginal] = useState(false)
  const [isInpaintingLoading, setIsProcessingLoading] = useState(false)
  const [generateProgress, setGenerateProgress] = useState(0)
  const modalRef = useRef(null)
  const [separator, setSeparator] = useState<HTMLDivElement>()
  const [useSeparator, setUseSeparator] = useState(false)
  const [originalImg, setOriginalImg] = useState<HTMLDivElement>()
  const [separatorLeft, setSeparatorLeft] = useState(0)
  const historyListRef = useRef<HTMLDivElement>(null)
  const isBrushSizeChange = useRef<boolean>(false)
  const scaledBrushSize = brushSize
  const canvasDiv = useRef<HTMLDivElement>(null)
  const [downloaded, setDownloaded] = useState(true)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string>()
  const windowSize = useWindowSize()
  const toolsDisabled = !file || isInpaintingLoading
  const canApplyMask = Boolean(
    file && pendingLines.some(line => line.pts.length)
  )
  const canRedo = Boolean(redoPendingLines.length || redoRenders.length)
  const brushPresets = [18, 36, 72, 120]

  function renderIcon(iconName: string) {
    return (
      <span className="material-symbols-rounded" aria-hidden="true">
        {iconName}
      </span>
    )
  }

  const draw = useCallback(
    (index = -1) => {
      if (!context) {
        return
      }
      context.clearRect(0, 0, context.canvas.width, context.canvas.height)
      const currRender =
        renders[index === -1 ? renders.length - 1 : index] ?? original
      const { canvas } = context
      const canvasHost = canvasDiv.current

      if (!canvasHost) {
        return
      }

      const divWidth = canvasHost.offsetWidth
      const divHeight = canvasHost.offsetHeight

      // 计算宽高比
      const imgAspectRatio = currRender.width / currRender.height
      const divAspectRatio = divWidth / divHeight

      let canvasWidth
      let canvasHeight

      // 比较宽高比以决定如何缩放
      if (divAspectRatio > imgAspectRatio) {
        // div 较宽，基于高度缩放
        canvasHeight = divHeight
        canvasWidth = currRender.width * (divHeight / currRender.height)
      } else {
        // div 较窄，基于宽度缩放
        canvasWidth = divWidth
        canvasHeight = currRender.height * (divWidth / currRender.width)
      }

      canvas.width = canvasWidth
      canvas.height = canvasHeight

      if (currRender?.src) {
        context.drawImage(currRender, 0, 0, canvas.width, canvas.height)
      } else {
        context.drawImage(original, 0, 0, canvas.width, canvas.height)
      }
      drawLines(context, pendingLines)
    },
    [context, original, pendingLines, renders]
  )

  const refreshCanvasMask = useCallback(() => {
    if (!context?.canvas.width || !context?.canvas.height) {
      throw new Error('canvas has invalid size')
    }
    maskCanvas.width = context?.canvas.width
    maskCanvas.height = context?.canvas.height
    const ctx = maskCanvas.getContext('2d')
    if (!ctx) {
      throw new Error('could not retrieve mask canvas')
    }
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
    drawLines(ctx, pendingLines, 'white')
  }, [context?.canvas.height, context?.canvas.width, maskCanvas, pendingLines])

  const onloading = useCallback(() => {
    setIsProcessingLoading(true)
    setGenerateProgress(0)
    const progressTimer = window.setInterval(() => {
      setGenerateProgress(p => {
        if (p < 90) return p + 10 * Math.random()
        if (p >= 90 && p < 99) return p + 1 * Math.random()
        // Do not hide the progress bar after 99%,cause sometimes long time progress
        // window.setTimeout(() => setIsInpaintingLoading(false), 500)
        return p
      })
    }, 1000)
    return {
      close: () => {
        clearInterval(progressTimer)
        setGenerateProgress(100)
        setIsProcessingLoading(false)
      },
    }
  }, [])

  const processMask = useCallback(async () => {
    if (!file || !context || !canApplyMask || showOriginal) {
      return
    }

    const loading = onloading()
    refreshCanvasMask()

    try {
      const newFile = renders[renders.length - 1] ?? file
      const res = await inpaint(newFile, maskCanvas.toDataURL())
      if (!res) {
        throw new Error('empty response')
      }

      const newRender = new Image()
      newRender.dataset.id = Date.now().toString()
      await loadImage(newRender, res)
      setRedoRenders([])
      setRedoPendingLines([])
      setRenders(currentRenders => [...currentRenders, newRender])
      setPendingLines([])
    } catch (e: any) {
      setErrorMessage(e.message ? e.message : e.toString())
    }

    if (historyListRef.current) {
      const { scrollWidth, clientWidth } = historyListRef.current
      if (scrollWidth > clientWidth) {
        historyListRef.current.scrollTo(scrollWidth, 0)
      }
    }

    loading.close()
  }, [
    canApplyMask,
    context,
    file,
    maskCanvas,
    onloading,
    refreshCanvasMask,
    renders,
    showOriginal,
  ])

  // Draw once the original image is loaded
  useEffect(() => {
    if (!context?.canvas) {
      return
    }
    if (isOriginalLoaded) {
      draw()
    }
  }, [context?.canvas, draw, original, isOriginalLoaded, windowSize])

  useEffect(() => {
    if (!file) {
      setRenders([])
      setRedoRenders([])
      setPendingLines([])
      setRedoPendingLines([])
      setShowOriginal(false)
      setSeparatorLeft(0)
      setToolMode('brush')
    }
  }, [file])

  // Handle mouse interactions
  useEffect(() => {
    const canvas = context?.canvas
    if (!canvas) {
      return
    }
    const onMouseMove = (ev: MouseEvent) => {
      if (brushRef.current) {
        const x = ev.clientX - scaledBrushSize / 2
        const y = ev.clientY - scaledBrushSize / 2

        brushRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`
      }
    }
    const onPaint = (px: number, py: number) => {
      setPendingLines(currentLines => {
        if (!currentLines.length) {
          return currentLines
        }

        const nextLines = [...currentLines]
        const currentLine = nextLines[nextLines.length - 1]
        nextLines[nextLines.length - 1] = {
          ...currentLine,
          pts: [...currentLine.pts, { x: px, y: py }],
        }
        return nextLines
      })
    }
    const onMouseDrag = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const px = ev.clientX - rect.left
      const py = ev.clientY - rect.top
      onPaint(px, py)
    }

    const onPointerUp = () => {
      canvas.removeEventListener('mousemove', onMouseDrag)
      canvas.removeEventListener('mouseup', onPointerUp)
    }
    canvas.addEventListener('mousemove', onMouseMove)

    const onTouchMove = (ev: TouchEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      const coords = canvas.getBoundingClientRect()
      onPaint(
        ev.touches[0].clientX - coords.left,
        ev.touches[0].clientY - coords.top
      )
    }
    const onPointerStart = () => {
      if (!original.src || showOriginal) {
        return
      }
      setRedoPendingLines([])
      setPendingLines(currentLines => [
        ...currentLines,
        { size: brushSize, pts: [], mode: toolMode },
      ])
      canvas.addEventListener('mousemove', onMouseDrag)
      canvas.addEventListener('mouseup', onPointerUp)
    }

    canvas.addEventListener('touchstart', onPointerStart)
    canvas.addEventListener('touchmove', onTouchMove)
    canvas.addEventListener('touchend', onPointerUp)
    canvas.onmouseenter = () => {
      window.clearTimeout(hideBrushTimeout)
      setShowBrush(true && !showOriginal)
    }
    canvas.onmouseleave = () => setShowBrush(false)
    canvas.onmousedown = onPointerStart

    return () => {
      canvas.removeEventListener('mousemove', onMouseDrag)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseup', onPointerUp)
      canvas.removeEventListener('touchstart', onPointerStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onPointerUp)
      canvas.onmouseenter = null
      canvas.onmouseleave = null
      canvas.onmousedown = null
    }
  }, [
    brushSize,
    context,
    original.src,
    showOriginal,
    hideBrushTimeout,
    scaledBrushSize,
    toolMode,
  ])

  useEffect(() => {
    if (!separator || !originalImg) return

    const separatorMove = (ev: MouseEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (context?.canvas) {
        const { width } = context?.canvas
        const canvasRect = context?.canvas.getBoundingClientRect()
        const separatorOffsetLeft = ev.pageX - canvasRect.left
        if (separatorOffsetLeft <= width && separatorOffsetLeft >= 0) {
          setSeparatorLeft(separatorOffsetLeft)
        } else if (separatorOffsetLeft < 0) {
          setSeparatorLeft(0)
        } else if (separatorOffsetLeft > width) {
          setSeparatorLeft(width)
        }
      }
    }

    const separatorDown = () => {
      window.addEventListener('mousemove', separatorMove)
      setUseSeparator(true)
    }

    const separatorUp = () => {
      window.removeEventListener('mousemove', separatorMove)
      setUseSeparator(false)
    }

    separator.addEventListener('mousedown', separatorDown)
    window.addEventListener('mouseup', separatorUp)

    return () => {
      separator.removeEventListener('mousedown', separatorDown)
      window.removeEventListener('mouseup', separatorUp)
    }
  }, [separator, context, originalImg])

  function download() {
    const currRender = renders[renders.length - 1] ?? original
    downloadImage(currRender.currentSrc, 'IMG')
  }

  const undo = useCallback(async () => {
    if (pendingLines.length) {
      const lastLine = pendingLines[pendingLines.length - 1]
      setPendingLines(currentLines => currentLines.slice(0, -1))
      setRedoPendingLines(currentLines => [...currentLines, lastLine])
      return
    }

    if (!renders.length) {
      return
    }

    const lastRender = renders[renders.length - 1]
    setRenders(currentRenders => currentRenders.slice(0, -1))
    setRedoRenders(currentRenders => [...currentRenders, lastRender])
    setShowOriginal(false)
    setSeparatorLeft(0)
  }, [pendingLines, renders])

  const redo = useCallback(() => {
    if (redoPendingLines.length) {
      const nextLine = redoPendingLines[redoPendingLines.length - 1]
      setRedoPendingLines(currentLines => currentLines.slice(0, -1))
      setPendingLines(currentLines => [...currentLines, nextLine])
      return
    }

    if (!redoRenders.length) {
      return
    }

    const nextRender = redoRenders[redoRenders.length - 1]
    setRedoRenders(currentRenders => currentRenders.slice(0, -1))
    setRenders(currentRenders => [...currentRenders, nextRender])
  }, [redoPendingLines, redoRenders])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!renders.length && !pendingLines.length) {
        return
      }
      const isCmdZ = (event.metaKey || event.ctrlKey) && event.key === 'z'
      const isCmdShiftZ =
        (event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Z'
      if (isCmdShiftZ) {
        event.preventDefault()
        redo()
      } else if (isCmdZ) {
        event.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [renders, pendingLines.length, redo, undo])

  const backTo = useCallback(
    (index: number) => {
      setRenders(currentRenders => currentRenders.slice(0, Math.max(index, 0)))
      setRedoRenders([])
      setPendingLines([])
      setRedoPendingLines([])
      setShowOriginal(false)
      setSeparatorLeft(0)
      window.requestAnimationFrame(() => {
        if (index === 0) {
          draw(renders.length)
          return
        }

        draw(index - 1)
      })
    },
    [draw, renders.length]
  )

  const previewHistoryItem = useCallback(
    (historyIndex: number) => {
      if (historyIndex === 0) {
        draw(renders.length)
        return
      }

      draw(historyIndex - 1)
    },
    [draw, renders.length]
  )

  const historyItems = useMemo(() => {
    if (!file || !isOriginalLoaded || !original.src) {
      return [] as Array<{
        id: string
        image: HTMLImageElement
        historyIndex: number
        isOriginal: boolean
      }>
    }

    return [
      {
        id: 'original-preview',
        image: original,
        historyIndex: 0,
        isOriginal: true,
      },
      ...renders.map((render, index) => ({
        id: render.dataset.id ?? `render-${index}`,
        image: render,
        historyIndex: index + 1,
        isOriginal: false,
      })),
    ]
  }, [file, isOriginalLoaded, original, renders])

  const History = useMemo(
    () =>
      historyItems.map(item => {
        return (
          <div
            key={item.id}
            className="group relative flex h-[104px] w-full shrink-0 items-center justify-center rounded-2xl border border-white/10 p-2 shadow-[0_16px_30px_rgba(0,0,0,0.28)] transition duration-150 ease-out hover:border-primary/30 hover:shadow-[0_20px_36px_rgba(0,0,0,0.36)]"
          >
            <img
              src={item.image.src}
              alt="render"
              className="max-h-full max-w-full rounded-xl object-contain shadow-[0_12px_28px_rgba(0,0,0,0.35)]"
              style={{
                height: '90px',
              }}
            />
            <Button
              className={[
                'cursor-pointer rounded-xl border-0 bg-transparent text-transparent shadow-none',
                'opacity-100 hover:bg-transparent hover:text-slate-200',
              ].join(' ')}
              style={{
                position: 'absolute',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => backTo(item.historyIndex)}
              onEnter={() => previewHistoryItem(item.historyIndex)}
              onLeave={draw}
            >
              <div
                className={[
                  'rounded-full border border-white/10 bg-[#11151b]/82 px-3 py-1 text-center text-xs text-slate-200 transition duration-150 ease-out',
                  item.isOriginal
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100',
                ].join(' ')}
              >
                {item.isOriginal ? '原图' : '回到这'}
                <br />
                {item.isOriginal ? 'Original' : 'Back here'}
              </div>
            </Button>
          </div>
        )
      }),
    [historyItems, backTo, previewHistoryItem, draw]
  )

  const handleSliderStart = () => {
    setShowBrush(true)
  }
  const handleSliderChange = (sliderValue: number) => {
    if (!isBrushSizeChange.current) {
      isBrushSizeChange.current = true
    }
    if (brushRef.current) {
      const x = document.documentElement.clientWidth / 2 - scaledBrushSize / 2
      const y = document.documentElement.clientHeight / 2 - scaledBrushSize / 2

      brushRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    setBrushSize(sliderValue)
    window.clearTimeout(hideBrushTimeout)
    setHideBrushTimeout(
      window.setTimeout(() => {
        setShowBrush(false)
      }, BRUSH_HIDE_ON_SLIDER_CHANGE_TIMEOUT)
    )
  }

  const onSuperResolution = useCallback(async () => {
    if (!file) {
      return
    }

    if (!(await modelExists('superResolution'))) {
      setDownloaded(false)
      await downloadModel('superResolution', setDownloadProgress)
      setDownloaded(true)
    }
    setIsProcessingLoading(true)
    try {
      // 运行
      const newFile = renders[renders.length - 1] ?? file
      const res = await superResolution(newFile, setGenerateProgress)
      if (!res) {
        throw new Error('empty response')
      }
      // TODO: fix the render if it failed loading
      const newRender = new Image()
      newRender.dataset.id = Date.now().toString()
      await loadImage(newRender, res)
      setRedoRenders([])
      setRedoPendingLines([])
      setRenders(currentRenders => [...currentRenders, newRender])
      setPendingLines([])
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloaded(true)
      setIsProcessingLoading(false)
    }
  }, [file, renders])

  return (
    <div className="flex min-w-0 flex-1 gap-4">
      <aside className="hidden w-[280px] shrink-0 lg:block">
        <div className="flex h-full flex-col rounded-3xl border border-white/10 bg-[#14181d]/92 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              History
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-100">
              Image Timeline
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              This workspace only handles one image at a time. The original
              image stays pinned at the top and each processed result is
              appended below it.
            </p>
          </div>

          <div
            ref={historyListRef}
            className={[
              'mt-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/8 bg-black/20 p-3',
              'scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent',
            ].join(' ')}
          >
            {historyItems.length > 0 ? (
              History
            ) : (
              <div className="flex h-full items-center text-sm text-slate-500">
                History previews will appear here after you load an image and
                run edits.
              </div>
            )}
          </div>
        </div>
      </aside>

      <section
        className={[
          'flex min-w-0 flex-1 flex-col rounded-3xl border border-white/10 bg-[#14181d]/92 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl',
          isInpaintingLoading ? 'animate-pulse-fast pointer-events-none' : '',
        ].join(' ')}
      >
        <div
          className="relative flex min-h-0 flex-1 justify-center"
          ref={canvasDiv}
        >
          {file ? (
            <div className="relative flex w-full items-center justify-center overflow-hidden rounded-2xl border border-white/8 bg-[radial-gradient(circle_at_top,_rgba(47,140,255,0.16),_rgba(18,22,28,0.94)_42%,_rgba(10,12,15,0.98))] p-6">
              <div className="relative flex max-h-full max-w-full items-center justify-center rounded-[28px] border border-white/8 bg-[#1a1f26]/92 p-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm">
                <canvas
                  className="rounded-xl"
                  style={showBrush ? { cursor: 'none' } : {}}
                  ref={r => {
                    if (r && !context) {
                      const ctx = r.getContext('2d')
                      if (ctx) {
                        setContext(ctx)
                      }
                    }
                  }}
                />
                <div
                  className={[
                    'absolute top-3 right-3 pointer-events-none',
                    showOriginal ? '' : 'overflow-hidden',
                  ].join(' ')}
                  style={{
                    width: showOriginal ? `${context?.canvas.width}px` : '0px',
                    height: context?.canvas.height,
                    transitionProperty: 'width, height',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '300ms',
                  }}
                  ref={r => {
                    if (r && !originalImg) {
                      setOriginalImg(r)
                    }
                  }}
                >
                  <div
                    className={[
                      'absolute top-0 right-0 pointer-events-none z-10 w-1',
                      'flex items-center justify-center separator',
                      useSeparator ? 'bg-black text-white' : 'bg-primary ',
                    ].join(' ')}
                    style={{
                      left: `${separatorLeft}px`,
                      height: context?.canvas.height,
                      transitionProperty: 'width, height',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '300ms',
                    }}
                  >
                    <span className="absolute left-1 bottom-0 rounded bg-black/50 p-1 text-white select-none">
                      original
                    </span>
                    <div
                      className={[
                        'absolute pointer-events-auto rounded-md px-1 py-2',
                        useSeparator ? 'bg-black' : 'bg-primary ',
                      ].join(' ')}
                      style={{ cursor: 'ew-resize' }}
                      ref={r => {
                        if (r && !separator) {
                          setSeparator(r)
                        }
                      }}
                    >
                      <ViewBoardsIcon
                        className="w-5 h-5"
                        style={{ cursor: 'ew-resize' }}
                      />
                    </div>
                  </div>
                  <img
                    className="absolute right-0 rounded-xl"
                    src={original.src}
                    alt="original"
                    width={`${context?.canvas.width}px`}
                    height={`${context?.canvas.height}px`}
                    style={{
                      width: `${context?.canvas.width}px`,
                      height: `${context?.canvas.height}px`,
                      maxWidth: 'none',
                      clipPath: `inset(0 0 0 ${separatorLeft}px)`,
                    }}
                  />
                </div>
              </div>
              {isInpaintingLoading && (
                <div className="absolute inset-0 z-10 flex h-full w-full items-center justify-center bg-black/55 backdrop-blur-sm">
                  <div
                    ref={modalRef}
                    className="w-4/5 space-y-5 rounded-3xl border border-white/10 bg-[#161a20]/95 p-8 text-xl text-slate-100 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:w-1/2"
                  >
                    <p>正在处理中，请耐心等待。。。</p>
                    <p>It is being processed, please be patient...</p>
                    <Progress percent={generateProgress} />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-white/12 bg-black/20 px-6 py-10 text-center">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                Display
              </p>
              <h2 className="mt-3 text-3xl font-semibold text-slate-100">
                Upload an image to start editing
              </h2>
              <p className="mt-3 max-w-2xl text-sm text-slate-400">
                The center panel is used for previewing the image, drawing masks
                on the canvas and checking processing history.
              </p>

              <div className="mt-8 h-72 w-full max-w-3xl">
                <FileSelect onSelection={onFileSelection} />
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="hidden w-[320px] shrink-0 xl:block">
        <div className="flex h-full flex-col rounded-3xl border border-white/10 bg-[#14181d]/92 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              Actions
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-100">
              Interaction Panel
            </h2>
          </div>

          <div className="mt-6 rounded-2xl border border-white/8 bg-black/20 p-4">
            <p className="text-sm font-semibold text-slate-100">Actions</p>

            <div className="mt-4 grid grid-cols-4 gap-2">
              <Button
                iconOnly
                className="w-full"
                disabled={!file}
                icon={renderIcon('add_photo_alternate')}
                onClick={onReset}
              >
                New
              </Button>
              <Button
                iconOnly
                className="w-full"
                disabled={!renders.length && !pendingLines.length}
                icon={renderIcon('undo')}
                onClick={undo}
              >
                Undo
              </Button>
              <Button
                iconOnly
                className="w-full"
                disabled={!canRedo}
                icon={renderIcon('redo')}
                onClick={redo}
              >
                Redo
              </Button>
              <Button
                iconOnly
                className="w-full"
                disabled={toolsDisabled}
                icon={renderIcon('download')}
                onClick={download}
              >
                Download
              </Button>
            </div>

            <div className="mt-5 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <p className="text-sm font-semibold text-slate-100">Tools</p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  primary={toolMode === 'brush'}
                  className="w-full justify-center"
                  disabled={toolsDisabled}
                  icon={renderIcon('brush')}
                  onClick={() => setToolMode('brush')}
                >
                  Brush
                </Button>
                <Button
                  primary={toolMode === 'eraser'}
                  className="w-full justify-center"
                  disabled={toolsDisabled}
                  icon={renderIcon('ink_eraser')}
                  onClick={() => setToolMode('eraser')}
                >
                  Eraser
                </Button>
              </div>

              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.22em] text-slate-500">
                  <span>
                    {toolMode === 'brush' ? 'Brush Size' : 'Eraser Size'}
                  </span>
                  <span>{brushSize}px</span>
                </div>
                <Slider
                  label={m.bruch_size()}
                  min={10}
                  max={200}
                  value={brushSize}
                  onChange={handleSliderChange}
                  onStart={handleSliderStart}
                />
                <div className="grid grid-cols-4 gap-2">
                  {brushPresets.map(size => (
                    <Button
                      key={size}
                      primary={brushSize === size}
                      className="w-full justify-center px-0 text-sm"
                      disabled={toolsDisabled}
                      onClick={() => handleSliderChange(size)}
                    >
                      {size}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <Button
                primary
                className="w-full justify-center"
                disabled={!canApplyMask || showOriginal}
                icon={renderIcon('auto_fix_high')}
                onClick={processMask}
              >
                Apply
              </Button>
              <Button
                primary
                className="w-full justify-center"
                disabled={toolsDisabled}
                icon={renderIcon('compare')}
                onClick={() => {
                  setShowOriginal(!showOriginal)
                  setTimeout(() => setSeparatorLeft(0), 300)
                }}
              >
                Original Compare
              </Button>
              <Button
                primary
                className="w-full justify-center"
                disabled={toolsDisabled || showOriginal}
                icon={renderIcon('zoom_in')}
                onClick={onSuperResolution}
              >
                4x Upscale
              </Button>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 p-4 text-sm text-slate-400">
            Draw the mask in the center panel, then click Apply Mask manually to
            run the inpainting step.
          </div>
        </div>
      </aside>

      {!downloaded && (
        <Modal>
          <div className="text-xl space-y-5">
            <p>{m.upscaleing_model_download_message()}</p>
            <Progress percent={downloadProgress} />
          </div>
        </Modal>
      )}
      {errorMessage && (
        <Modal>
          <div className="text-xl space-y-5">
            <p>{errorMessage}</p>
            <Button onClick={() => setErrorMessage(undefined)}>Close</Button>
          </div>
        </Modal>
      )}
      {showBrush && (
        <div
          className="pointer-events-none fixed left-0 top-0 rounded-full border border-sky-300/70 bg-primary/20 shadow-[0_0_0_1px_rgba(47,140,255,0.25),0_0_24px_rgba(47,140,255,0.28)]"
          style={{
            width: `${scaledBrushSize}px`,
            height: `${scaledBrushSize}px`,
            transform: `translate3d(-100px, -100px, 0)`,
          }}
          ref={brushRef}
        />
      )}
    </div>
  )
}
