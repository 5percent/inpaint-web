/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable jsx-a11y/control-has-associated-label */
import {
  ClipboardListIcon,
  InformationCircleIcon,
} from '@heroicons/react/outline'
import { useEffect, useRef, useState } from 'react'
import { useClickAway } from 'react-use'
import Button from './components/Button'
import Modal from './components/Modal'
import Editor from './Editor'
import { resizeImageFile } from './utils'
import Progress from './components/Progress'
import { downloadModel } from './adapters/cache'
import * as m from './paraglide/messages'
import {
  languageTag,
  onSetLanguageTag,
  setLanguageTag,
} from './paraglide/runtime'

function App() {
  const [file, setFile] = useState<File>()
  const [, setStateLanguageTag] = useState<'en' | 'zh'>('zh')

  const [showAbout, setShowAbout] = useState(false)
  const modalRef = useRef(null)

  const [downloadProgress, setDownloadProgress] = useState(100)
  const [downloadError, setDownloadError] = useState<string>()

  useEffect(() => {
    onSetLanguageTag(() => setStateLanguageTag(languageTag()))
  }, [])

  useEffect(() => {
    let isMounted = true

    async function preloadModel() {
      try {
        await downloadModel('inpaint', setDownloadProgress)
      } catch (error) {
        if (!isMounted) {
          return
        }

        setDownloadError(error instanceof Error ? error.message : String(error))
      }
    }

    preloadModel()

    return () => {
      isMounted = false
    }
  }, [])

  useClickAway(modalRef, () => {
    setShowAbout(false)
  })

  async function handleFileSelection(selectedFile: File) {
    const { file: resizedFile } = await resizeImageFile(selectedFile, 1024 * 4)
    setFile(resizedFile)
  }

  return (
    <div className="min-h-screen bg-transparent text-slate-100">
      <header className="z-10 border-b border-white/10 bg-[#12161c]/86 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1800px] items-center justify-between px-4 sm:px-6">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-slate-500">
              Workspace
            </p>
            <div className="text-2xl font-semibold tracking-tight text-slate-100">
              Inpaint-web
            </div>
          </div>

          <div className="hidden md:flex justify-end gap-3">
            <Button
              className="min-w-[148px] justify-center"
              disabled={!file}
              icon={<ClipboardListIcon className="w-6 h-6" />}
              onClick={() => {
                setFile(undefined)
              }}
            >
              {m.start_new()}
            </Button>
            <Button
              className="flex"
              onClick={() => {
                if (languageTag() === 'zh') {
                  setLanguageTag('en')
                } else {
                  setLanguageTag('zh')
                }
              }}
            >
              <p>{languageTag() === 'en' ? '切换到中文' : 'en'}</p>
            </Button>
            <Button
              className="w-38 flex sm:visible"
              icon={<InformationCircleIcon className="w-6 h-6" />}
              onClick={() => {
                setShowAbout(true)
              }}
            >
              <p>{m.feedback()}</p>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-64px)] w-full max-w-[1800px] gap-4 px-4 py-4 sm:px-6">
        <Editor
          file={file}
          onFileSelection={handleFileSelection}
          onReset={() => setFile(undefined)}
        />
      </main>

      {showAbout && (
        <Modal>
          <div ref={modalRef} className="space-y-5 text-xl text-slate-200">
            <p>
              {' '}
              任何问题到:{' '}
              <a
                href="https://github.com/lxfater/inpaint-web"
                className="text-sky-400"
                rel="noreferrer"
                target="_blank"
              >
                Inpaint-web
              </a>{' '}
              反馈
            </p>
            <p>
              {' '}
              For any questions, please go to:{' '}
              <a
                href="https://github.com/lxfater/inpaint-web"
                className="text-sky-400"
                rel="noreferrer"
                target="_blank"
              >
                Inpaint-web
              </a>{' '}
              to provide feedback.
            </p>
          </div>
        </Modal>
      )}
      {!(downloadProgress === 100) && (
        <Modal>
          <div className="space-y-5 text-xl text-slate-100">
            <p>{m.inpaint_model_download_message()}</p>
            <Progress percent={downloadProgress} />
          </div>
        </Modal>
      )}
      {downloadError && (
        <Modal>
          <div className="space-y-5 text-xl text-slate-100">
            <p>{downloadError}</p>
            <Button onClick={() => setDownloadError(undefined)}>Close</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default App
