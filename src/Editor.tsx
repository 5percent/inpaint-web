/* eslint-disable jsx-a11y/click-events-have-key-events */
/* eslint-disable jsx-a11y/no-static-element-interactions */
import { DownloadIcon, EyeIcon, ViewBoardsIcon } from '@heroicons/react/outline'
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
  onStartWithDemoImage: (image: string) => void | Promise<void>
  onReset: () => void
}

interface Line {
  size?: number
  pts: { x: number; y: number }[]
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: Line[],
  color = 'rgba(255, 0, 0, 0.5)'
) {
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  lines.forEach(line => {
    if (!line?.pts.length || !line.size) {
      return
    }
    ctx.lineWidth = line.size
    ctx.beginPath()
    ctx.moveTo(line.pts[0].x, line.pts[0].y)
    line.pts.forEach(pt => ctx.lineTo(pt.x, pt.y))
    ctx.stroke()
  })
}

const BRUSH_HIDE_ON_SLIDER_CHANGE_TIMEOUT = 2000
export default function Editor(props: EditorProps) {
  const { file, onFileSelection, onStartWithDemoImage, onReset } = props
  const [brushSize, setBrushSize] = useState(40)
  const [original, isOriginalLoaded] = useImage(file)
  const [renders, setRenders] = useState<HTMLImageElement[]>([])
  const [context, setContext] = useState<CanvasRenderingContext2D>()
  const [maskCanvas] = useState<HTMLCanvasElement>(() => {
    return document.createElement('canvas')
  })
  const [pendingLines, setPendingLines] = useState<Line[]>([])
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
  const demoImages = ['bag', 'dog', 'car', 'bird', 'jacket', 'shoe', 'paris']
  const toolsDisabled = !file || isInpaintingLoading
  const canApplyMask = Boolean(
    file && pendingLines.some(line => line.pts.length)
  )

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
      setPendingLines([])
      setShowOriginal(false)
      setSeparatorLeft(0)
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
      setPendingLines(currentLines => [
        ...currentLines,
        { size: brushSize, pts: [] },
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
      setPendingLines(currentLines => currentLines.slice(0, -1))
      return
    }

    setRenders(currentRenders => currentRenders.slice(0, -1))
    setShowOriginal(false)
    setSeparatorLeft(0)
  }, [pendingLines.length])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!renders.length) {
        return
      }
      const isCmdZ = (event.metaKey || event.ctrlKey) && event.key === 'z'
      if (isCmdZ) {
        event.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [renders, undo])

  const backTo = useCallback(
    (index: number) => {
      setRenders(currentRenders => currentRenders.slice(0, Math.max(index, 0)))
      setPendingLines([])
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
            className="relative flex h-[104px] w-full shrink-0 items-center justify-center rounded-2xl border border-stone-200 bg-white p-2"
          >
            <img
              src={item.image.src}
              alt="render"
              className="max-h-full max-w-full rounded-sm object-contain"
              style={{
                height: '90px',
              }}
            />
            <Button
              className={[
                'cursor-pointer rounded-sm',
                item.isOriginal ? 'opacity-100' : 'hover:opacity-100 opacity-0',
              ].join(' ')}
              style={{
                position: 'absolute',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => backTo(item.historyIndex)}
              onEnter={() => previewHistoryItem(item.historyIndex)}
              onLeave={draw}
            >
              <div
                style={{
                  color: '#fff',
                  fontSize: '12px',
                  textAlign: 'center',
                }}
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
        <div className="flex h-full flex-col rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              History
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">
              Image Timeline
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              This workspace only handles one image at a time. The original
              image stays pinned at the top and each processed result is
              appended below it.
            </p>
          </div>

          <div
            ref={historyListRef}
            className={[
              'mt-6 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-stone-200 bg-stone-50 p-3',
              'scrollbar-thin scrollbar-thumb-black scrollbar-track-primary',
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
          'flex min-w-0 flex-1 flex-col rounded-3xl border border-stone-200 bg-white p-4 shadow-sm',
          isInpaintingLoading ? 'animate-pulse-fast pointer-events-none' : '',
        ].join(' ')}
      >
        <div
          className="relative flex min-h-0 flex-1 justify-center"
          ref={canvasDiv}
        >
          {file ? (
            <div className="relative flex w-full items-center justify-center overflow-hidden rounded-2xl border border-stone-200 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.95),_rgba(241,245,249,0.92)_45%,_rgba(226,232,240,0.85))] p-6">
              <div className="relative flex max-h-full max-w-full items-center justify-center rounded-[28px] bg-white/90 p-3 shadow-[0_24px_80px_rgba(15,23,42,0.12)] backdrop-blur-sm">
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
                    <span className="absolute left-1 bottom-0 rounded bg-black bg-opacity-25 p-1 text-white select-none">
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
                <div className="absolute inset-0 z-10 flex h-full w-full items-center justify-center bg-white bg-opacity-80">
                  <div
                    ref={modalRef}
                    className="w-4/5 space-y-5 text-xl sm:w-1/2"
                  >
                    <p>正在处理中，请耐心等待。。。</p>
                    <p>It is being processed, please be patient...</p>
                    <Progress percent={generateProgress} />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-stone-50 px-6 py-10 text-center">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                Display
              </p>
              <h2 className="mt-3 text-3xl font-semibold text-slate-900">
                Upload an image to start editing
              </h2>
              <p className="mt-3 max-w-2xl text-sm text-slate-500">
                The center panel is used for previewing the image, drawing masks
                on the canvas and checking processing history.
              </p>

              <div className="mt-8 h-72 w-full max-w-3xl">
                <FileSelect onSelection={onFileSelection} />
              </div>

              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <span className="text-sm text-slate-500">
                  {m.try_it_images()}
                </span>
                {demoImages.map(image => (
                  <div
                    key={image}
                    onClick={() => onStartWithDemoImage(image)}
                    role="button"
                    onKeyDown={() => onStartWithDemoImage(image)}
                    tabIndex={-1}
                    className="overflow-hidden rounded-2xl border border-stone-200 bg-white p-1 shadow-sm"
                  >
                    <img
                      className="h-20 w-20 rounded-xl object-cover transition hover:opacity-75"
                      src={`examples/${image}.jpeg`}
                      alt={image}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="hidden w-[320px] shrink-0 xl:block">
        <div className="flex h-full flex-col rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              Actions
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">
              Interaction Panel
            </h2>
          </div>

          <div className="mt-6 rounded-2xl border border-stone-200 bg-stone-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Tools</p>
            <div className="mt-4 space-y-3">
              <Slider
                label={m.bruch_size()}
                min={10}
                max={200}
                value={brushSize}
                onChange={handleSliderChange}
                onStart={handleSliderStart}
              />
              <div className="space-y-2">
                {renders.length > 0 && (
                  <Button
                    primary
                    className="w-full justify-center"
                    onClick={undo}
                    icon={
                      <svg
                        className="w-6 h-6"
                        width="19"
                        height="9"
                        viewBox="0 0 19 9"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M2 1C2 0.447715 1.55228 0 1 0C0.447715 0 0 0.447715 0 1H2ZM1 8H0V9H1V8ZM8 9C8.55228 9 9 8.55229 9 8C9 7.44771 8.55228 7 8 7V9ZM16.5963 7.42809C16.8327 7.92721 17.429 8.14016 17.9281 7.90374C18.4272 7.66731 18.6402 7.07103 18.4037 6.57191L16.5963 7.42809ZM16.9468 5.83205L17.8505 5.40396L16.9468 5.83205ZM0 1V8H2V1H0ZM1 9H8V7H1V9ZM1.66896 8.74329L6.66896 4.24329L5.33104 2.75671L0.331035 7.25671L1.66896 8.74329ZM16.043 6.26014L16.5963 7.42809L18.4037 6.57191L17.8505 5.40396L16.043 6.26014ZM6.65079 4.25926C9.67554 1.66661 14.3376 2.65979 16.043 6.26014L17.8505 5.40396C15.5805 0.61182 9.37523 -0.710131 5.34921 2.74074L6.65079 4.25926Z"
                          fill="currentColor"
                        />
                      </svg>
                    }
                  >
                    {m.undo()}
                  </Button>
                )}
                <Button
                  primary={showOriginal}
                  className={[
                    'w-full justify-center',
                    toolsDisabled ? 'opacity-50 pointer-events-none' : '',
                  ].join(' ')}
                  icon={<EyeIcon className="w-6 h-6" />}
                  onUp={() => {
                    setShowOriginal(!showOriginal)
                    setTimeout(() => setSeparatorLeft(0), 300)
                  }}
                >
                  {m.original()}
                </Button>
                {!showOriginal && (
                  <Button
                    className={[
                      'w-full justify-center',
                      toolsDisabled ? 'opacity-50 pointer-events-none' : '',
                    ].join(' ')}
                    onUp={onSuperResolution}
                  >
                    {m.upscale()}
                  </Button>
                )}
                <Button
                  primary
                  className={[
                    'w-full justify-center',
                    !canApplyMask || showOriginal
                      ? 'opacity-50 pointer-events-none'
                      : '',
                  ].join(' ')}
                  onClick={processMask}
                >
                  Apply Mask
                </Button>
                <Button
                  primary
                  className={[
                    'w-full justify-center',
                    toolsDisabled ? 'opacity-50 pointer-events-none' : '',
                  ].join(' ')}
                  icon={<DownloadIcon className="w-6 h-6" />}
                  onClick={download}
                >
                  {m.download()}
                </Button>
                <Button
                  className={[
                    'w-full justify-center',
                    !file ? 'opacity-50 pointer-events-none' : '',
                  ].join(' ')}
                  onClick={onReset}
                >
                  {m.start_new()}
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm text-slate-500">
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
          className="fixed rounded-full bg-red-500 bg-opacity-50 pointer-events-none left-0 top-0"
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
