const { promisify } = require(`bluebird`)
const fs = require(`fs-extra`)
const _ = require(`lodash`)
const tmpDir = require(`os`).tmpdir()
const path = require(`path`)
const sharp = require(`./safe-sharp`)
const filenamify = require(`filenamify`)
const duotone = require(`./duotone`)
const { getPluginOptions, healOptions } = require(`./plugin-options`)
const { reportError } = require(`./report-error`)
const {
  createContentDigest,
} = require(`gatsby-core-utils/create-content-digest`)

exports.notMemoizedPrepareTraceSVGInputFile = async ({
  file,
  options,
  tmpFilePath,
  reporter,
}) => {
  let pipeline
  try {
    pipeline = sharp()

    if (!options.rotate) {
      pipeline.rotate()
    }
    fs.createReadStream(file.absolutePath).pipe(pipeline)
  } catch (err) {
    reportError(`Failed to process image ${file.absolutePath}`, err, reporter)
    return
  }

  pipeline
    .resize(options.width, options.height, {
      position: options.cropFocus,
    })
    .png({
      compressionLevel: options.pngCompressionLevel,
      adaptiveFiltering: false,
      force: options.toFormat === `png`,
    })
    .jpeg({
      quality: options.quality,
      progressive: options.jpegProgressive,
      force: options.toFormat === `jpg`,
    })

  // grayscale
  if (options.grayscale) {
    pipeline = pipeline.grayscale()
  }

  // rotate
  if (options.rotate && options.rotate !== 0) {
    pipeline = pipeline.rotate(options.rotate)
  }

  // duotone
  if (options.duotone) {
    pipeline = await duotone(options.duotone, options.toFormat, pipeline)
  }

  await new Promise((resolve, reject) =>
    pipeline.toFile(tmpFilePath, err => {
      if (err) {
        return reject(err)
      }
      return resolve()
    })
  )
}

const optimize = svg => {
  const { optimize } = require(`svgo`)
  const { data } = optimize(svg, {
    multipass: true,
    floatPrecision: 0,
    plugins: [
      {
        name: `preset-default`,
        params: {
          overrides: {
            // disable removeViewBox plugin
            removeViewBox: false,
          },
        },
      },
      {
        name: `addAttributesToSVGElement`,
        params: {
          attributes: [
            {
              preserveAspectRatio: `none`,
            },
          ],
        },
      },
    ],
  })
  return data
}

exports.notMemoizedtraceSVG = async ({ file, args, fileArgs, reporter }) => {
  const options = healOptions(
    getPluginOptions(),
    {
      // use maxWidth/maxHeight as width/height if available
      // if width/height is used in fileArgs, the maxWidth/maxHeight
      // values will be overritten
      ...(fileArgs && fileArgs.maxWidth && fileArgs.maxHeight
        ? {
            height: fileArgs.maxHeight,
            width: fileArgs.maxWidth,
          }
        : {}),
      ...fileArgs,
    },
    file.extension
  )

  const optionsHash = createContentDigest(options)

  const tmpFilePath = path.join(
    tmpDir,
    filenamify(`${file.internal.contentDigest}-${file.name}-${optionsHash}`) +
      `.${file.extension}`
  )

  await exports.memoizedPrepareTraceSVGInputFile({
    tmpFilePath,
    file,
    options,
    reporter,
  })

  const svgToMiniDataURI = require(`mini-svg-data-uri`)
  const potrace = require(`@gatsbyjs/potrace`)
  const trace = promisify(potrace.trace)

  const defaultArgs = {
    color: `lightgray`,
    optTolerance: 0.4,
    turdSize: 100,
    turnPolicy: potrace.Potrace.TURNPOLICY_MAJORITY,
  }

  const optionsSVG = _.defaults({}, args, defaultArgs)

  // `srcset` attribute rejects URIs with literal spaces
  const encodeSpaces = str => str.replace(/ /gi, `%20`)

  return trace(tmpFilePath, optionsSVG)
    .then(optimize)
    .then(svgToMiniDataURI)
    .then(encodeSpaces)
}

let memoizedPrepareTraceSVGInputFile
let memoizedTraceSVG
const createMemoizedFunctions = () => {
  exports.memoizedPrepareTraceSVGInputFile = memoizedPrepareTraceSVGInputFile =
    _.memoize(
      exports.notMemoizedPrepareTraceSVGInputFile,
      ({ tmpFilePath }) => tmpFilePath
    )

  exports.memoizedTraceSVG = memoizedTraceSVG = _.memoize(
    exports.notMemoizedtraceSVG,
    ({ file, args, fileArgs }) =>
      `${file.internal.contentDigest}${JSON.stringify(args)}${JSON.stringify(
        fileArgs
      )}`
  )
}

// This is very hacky, but memoized function are pretty tricky to spy on
// in tests ;(
createMemoizedFunctions()
exports.createMemoizedFunctions = () => {
  createMemoizedFunctions()
}

exports.clearMemoizeCaches = () => {
  memoizedTraceSVG.cache.clear()
  memoizedPrepareTraceSVGInputFile.cache.clear()
}
