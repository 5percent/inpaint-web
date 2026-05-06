import localforage from 'localforage'

export type modelType = 'inpaint' | 'superResolution'

localforage.config({
  name: 'modelCache',
})

export async function saveModel(modelType: modelType, modelBlob: ArrayBuffer) {
  await localforage.setItem(getModel(modelType).name, modelBlob)
}

function getModel(modelType: modelType) {
  if (modelType === 'inpaint') {
    const modelList = [
      {
        name: 'model',
        url: 'https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx',
        backupUrl: '',
      },
      {
        name: 'model-perf',
        url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan.onnx',
        backupUrl: '',
      },
      {
        name: 'migan-pipeline-v2',
        url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
        backupUrl:
          'https://worker-share-proxy-01f5.lxfater.workers.dev/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
      },
    ]
    const currentModel = modelList[2]
    return currentModel
  }
  if (modelType === 'superResolution') {
    const modelList = [
      {
        name: 'realesrgan-x4',
        url: 'https://huggingface.co/lxfater/inpaint-web/resolve/main/realesrgan-x4.onnx',
        backupUrl:
          'https://worker-share-proxy-01f5.lxfater.workers.dev/lxfater/inpaint-web/resolve/main/realesrgan-x4.onnx',
      },
    ]
    const currentModel = modelList[0]
    return currentModel
  }
  throw new Error('wrong modelType')
}

export async function loadModel(modelType: modelType): Promise<ArrayBuffer> {
  const model = (await localforage.getItem(getModel(modelType).name)) as
    | ArrayBuffer
    | Uint8Array

  if (model instanceof Uint8Array) {
    const buffer = new Uint8Array(model.byteLength)
    buffer.set(model)
    return buffer.buffer
  }

  return model
}

export async function modelExists(modelType: modelType) {
  const model = await loadModel(modelType)
  return model !== null && model !== undefined
}

export async function ensureModel(modelType: modelType) {
  if (await modelExists(modelType)) {
    return loadModel(modelType)
  }
  const model = getModel(modelType)
  const response = await fetch(model.url)
  const buffer = await response.arrayBuffer()
  await saveModel(modelType, buffer)
  return buffer
}

export async function downloadModel(
  modelType: modelType,
  setDownloadProgress: (arg0: number) => void
) {
  if (await modelExists(modelType)) {
    return
  }

  async function downloadFromUrl(url: string) {
    setDownloadProgress(0)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`)
    }

    const fullSize = response.headers.get('content-length')
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Model response stream is unavailable')
    }

    const total: Uint8Array[] = []
    let downloaded = 0
    const totalSize = Number(fullSize)
    let done = false

    while (!done) {
      const result = await reader.read()
      done = result.done

      if (done) {
        break
      }

      const { value } = result

      downloaded += value?.length || 0

      if (value) {
        total.push(value)
      }

      if (Number.isFinite(totalSize) && totalSize > 0) {
        setDownloadProgress((downloaded / totalSize) * 100)
      }
    }

    const buffer = new Uint8Array(downloaded)
    let offset = 0
    for (const chunk of total) {
      buffer.set(chunk, offset)
      offset += chunk.length
    }

    await saveModel(modelType, buffer.buffer)
    setDownloadProgress(100)
  }

  const model = getModel(modelType)
  try {
    await downloadFromUrl(model.url)
  } catch (error) {
    if (model.backupUrl) {
      try {
        await downloadFromUrl(model.backupUrl)
        return
      } catch (backupError) {
        throw new Error(
          `Failed to download model from both sources. Primary: ${String(
            error
          )}. Backup: ${String(backupError)}`
        )
      }
    }

    throw new Error(`Failed to download model: ${String(error)}`)
  }
}
