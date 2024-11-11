import fs, { readFileSync } from 'node:fs';
import { basename } from 'node:path/posix';
import { dim, green } from 'kleur/colors';
import type PQueue from 'p-queue';
import type { AstroConfig } from '../../@types/astro.js';
import { getOutDirWithinCwd } from '../../core/build/common.js';
import type { BuildPipeline } from '../../core/build/pipeline.js';
import { getTimeStat } from '../../core/build/util.js';
import { AstroError } from '../../core/errors/errors.js';
import { AstroErrorData } from '../../core/errors/index.js';
import type { Logger } from '../../core/logger/core.js';
import { isRemotePath, removeLeadingForwardSlash } from '../../core/path.js';
import { isServerLikeOutput } from '../../core/util.js';
import type { MapValue } from '../../type-utils.js';
import { getConfiguredImageService } from '../internal.js';
import type { LocalImageService } from '../services/service.js';
import type { AssetsGlobalStaticImagesList, ImageMetadata, ImageTransform } from '../types.js';
import { isESMImportedImage } from '../utils/imageKind.js';
import { type RemoteCacheEntry, loadRemoteImage } from './remote.js';

interface GenerationDataUncached {
	cached: CacheStatus.Miss;
	weight: {
		before: number;
		after: number;
	};
}

interface GenerationDataCached {
	cached: CacheStatus.Revalidated | CacheStatus.Hit;
}

type GenerationData = GenerationDataUncached | GenerationDataCached;

type AssetEnv = {
	logger: Logger;
	isSSR: boolean;
	count: { total: number; current: number };
	useCache: boolean;
	assetsCacheDir: URL;
	serverRoot: URL;
	clientRoot: URL;
	imageConfig: AstroConfig['image'];
	assetsFolder: AstroConfig['build']['assets'];
};

type ImageData = {
	data: Uint8Array;
	expires: number;
	etag?: string | null;
};

enum CacheStatus {
	Miss = 0,
	Revalidated,
	Hit,
}

export async function prepareAssetsGenerationEnv(
	pipeline: BuildPipeline,
	totalCount: number,
): Promise<AssetEnv> {
	const { config, logger } = pipeline;
	let useCache = true;
	const assetsCacheDir = new URL('assets/', config.cacheDir);
	const count = { total: totalCount, current: 1 };

	// Ensure that the cache directory exists
	try {
		await fs.promises.mkdir(assetsCacheDir, { recursive: true });
	} catch (err) {
		logger.warn(
			null,
			`An error was encountered while creating the cache directory. Proceeding without caching. Error: ${err}`,
		);
		useCache = false;
	}

	let serverRoot: URL, clientRoot: URL;
	if (isServerLikeOutput(config)) {
		serverRoot = config.build.server;
		clientRoot = config.build.client;
	} else {
		serverRoot = getOutDirWithinCwd(config.outDir);
		clientRoot = config.outDir;
	}

	return {
		logger,
		isSSR: isServerLikeOutput(config),
		count,
		useCache,
		assetsCacheDir,
		serverRoot,
		clientRoot,
		imageConfig: config.image,
		assetsFolder: config.build.assets,
	};
}

function getFullImagePath(originalFilePath: string, env: AssetEnv): URL {
	return new URL(removeLeadingForwardSlash(originalFilePath), env.serverRoot);
}

export async function generateImagesForPath(
	originalFilePath: string,
	transformsAndPath: MapValue<AssetsGlobalStaticImagesList>,
	env: AssetEnv,
	queue: PQueue,
) {
	let originalImage: ImageData;

	for (const [_, transform] of transformsAndPath.transforms) {
		await queue
			.add(async () => generateImage(transform.finalPath, transform.transform))
			.catch((e) => {
				throw e;
			});
	}

	// In SSR, we cannot know if an image is referenced in a server-rendered page, so we can't delete anything
	// For instance, the same image could be referenced in both a server-rendered page and build-time-rendered page
	if (
		!env.isSSR &&
		transformsAndPath.originalSrcPath &&
		!globalThis.astroAsset.referencedImages?.has(transformsAndPath.originalSrcPath)
	) {
		try {
			if (transformsAndPath.originalSrcPath) {
				env.logger.debug(
					'assets',
					`Deleting ${originalFilePath} as it's not referenced outside of image processing.`,
				);
				await fs.promises.unlink(getFullImagePath(originalFilePath, env));
			}
		} catch {
			/* No-op, it's okay if we fail to delete one of the file, we're not too picky. */
		}
	}

	async function generateImage(filepath: string, options: ImageTransform) {
		const timeStart = performance.now();
		const generationData = await generateImageInternal(filepath, options);

		const timeEnd = performance.now();
		const timeChange = getTimeStat(timeStart, timeEnd);
		const timeIncrease = `(+${timeChange})`;
		const statsText = generationData.cached
			? generationData.cached === CacheStatus.Hit
				? `(reused cache entry)`
				: `(revalidated cache entry)`
			: `(before: ${generationData.weight.before}kB, after: ${generationData.weight.after}kB)`;
		const count = `(${env.count.current}/${env.count.total})`;
		env.logger.info(
			null,
			`  ${green('▶')} ${filepath} ${dim(statsText)} ${dim(timeIncrease)} ${dim(count)}`,
		);
		env.count.current++;
	}

	async function generateImageInternal(
		filepath: string,
		options: ImageTransform,
	): Promise<GenerationData> {
		const isLocalImage = isESMImportedImage(options.src);
		const finalFileURL = new URL('.' + filepath, env.clientRoot);

		// For remote images, instead of saving the image directly, we save a JSON file with the image data, expiration date and etag from the server
		const cacheFile = basename(filepath) + (isLocalImage ? '' : '.json');
		const cachedFileURL = new URL(cacheFile, env.assetsCacheDir);

		// Check if we have a cached entry first
		try {
			if (isLocalImage) {
				await fs.promises.copyFile(cachedFileURL, finalFileURL, fs.constants.COPYFILE_FICLONE);

				return {
					cached: CacheStatus.Hit,
				};
			} else {
				const JSONData = JSON.parse(readFileSync(cachedFileURL, 'utf-8')) as RemoteCacheEntry;

				if (!JSONData.data || !JSONData.expires) {
					await fs.promises.unlink(cachedFileURL);

					throw new Error(
						`Malformed cache entry for ${filepath}, cache will be regenerated for this file.`,
					);
				}

				// If the cache entry is not expired, use it
				if (JSONData.expires > Date.now()) {
					await fs.promises.writeFile(finalFileURL, Buffer.from(JSONData.data, 'base64'));

					return {
						cached: CacheStatus.Hit,
					};
				}

				// Try to freshen the cache
				if (JSONData.etag) {
					const fresh = await loadImage(options.src as string, env, JSONData.etag);

					if (fresh.data.length) {
						originalImage = fresh;
					} else {
						fresh.data = Buffer.from(JSONData.data, 'base64'); // Reuse cache data as it is still good
						await writeRemoteCacheFile(cachedFileURL, fresh);
						await fs.promises.writeFile(finalFileURL, fresh.data);
						return { cached: CacheStatus.Revalidated };
					}
				}

				await fs.promises.unlink(cachedFileURL);
			}
		} catch (e: any) {
			if (e.code !== 'ENOENT') {
				throw new Error(`An error was encountered while reading the cache file. Error: ${e}`);
			}
			// If the cache file doesn't exist, just move on, and we'll generate it
		}

		const finalFolderURL = new URL('./', finalFileURL);
		await fs.promises.mkdir(finalFolderURL, { recursive: true });

		// The original filepath or URL from the image transform
		const originalImagePath = isLocalImage
			? (options.src as ImageMetadata).src
			: (options.src as string);

		if (!originalImage) {
			originalImage = await loadImage(originalFilePath, env);
		}

		let resultData: Partial<ImageData> = {
			data: undefined,
			expires: originalImage.expires,
			etag: originalImage.etag,
		};

		const imageService = (await getConfiguredImageService()) as LocalImageService;

		try {
			resultData.data = (
				await imageService.transform(
					originalImage.data,
					{ ...options, src: originalImagePath },
					env.imageConfig,
				)
			).data;
		} catch (e) {
			const error = new AstroError(
				{
					...AstroErrorData.CouldNotTransformImage,
					message: AstroErrorData.CouldNotTransformImage.message(originalFilePath),
				},
				{ cause: e },
			);

			throw error;
		}

		try {
			// Write the cache entry
			if (env.useCache) {
				if (isLocalImage) {
					await fs.promises.writeFile(cachedFileURL, resultData.data);
				} else {
					await writeRemoteCacheFile(cachedFileURL, resultData as ImageData);
				}
			}
		} catch (e) {
			env.logger.warn(
				null,
				`An error was encountered while creating the cache directory. Proceeding without caching. Error: ${e}`,
			);
		} finally {
			// Write the final file
			await fs.promises.writeFile(finalFileURL, resultData.data);
		}

		return {
			cached: CacheStatus.Miss,
			weight: {
				// Divide by 1024 to get size in kilobytes
				before: Math.trunc(originalImage.data.byteLength / 1024),
				after: Math.trunc(Buffer.from(resultData.data).byteLength / 1024),
			},
		};
	}
}

async function writeRemoteCacheFile(cachedFileURL: URL, resultData: ImageData) {
	return await fs.promises.writeFile(
		cachedFileURL,
		JSON.stringify({
			data: Buffer.from(resultData.data).toString('base64'),
			expires: resultData.expires,
			etag: resultData.etag,
		}),
	);
}

export function getStaticImageList(): AssetsGlobalStaticImagesList {
	if (!globalThis?.astroAsset?.staticImages) {
		return new Map();
	}

	return globalThis.astroAsset.staticImages;
}

async function loadImage(path: string, env: AssetEnv, etag?: string): Promise<ImageData> {
	if (isRemotePath(path)) {
		const remoteImage = await loadRemoteImage(path, etag);
		return {
			data: remoteImage.data,
			expires: remoteImage.expires,
			etag: remoteImage.etag,
		};
	}

	return {
		data: await fs.promises.readFile(getFullImagePath(path, env)),
		expires: 0,
	};
}
