import * as assert from 'assert'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as fsHelper from './fs-helper'
import * as github from '@actions/github'
import * as io from '@actions/io'
import * as path from 'path'
import * as retryHelper from './retry-helper'
import * as toolCache from '@actions/tool-cache'
import {default as uuid} from 'uuid/v4'
import {getServerApiUrl} from './url-helper'

const IS_WINDOWS = process.platform === 'win32'

export async function downloadRepository(
  authToken: string,
  owner: string,
  repo: string,
  ref: string,
  commit: string,
  repositoryPath: string,
  baseUrl?: string
): Promise<void> {
  // Determine the default branch
  if (!ref && !commit) {
    core.info('Determining the default branch')
    ref = await getDefaultBranch(authToken, owner, repo, baseUrl)
  }

  // Download the archive
  let archiveData = await retryHelper.execute(async () => {
    core.info('Downloading the archive')
    return await downloadArchive(authToken, owner, repo, ref, commit, baseUrl)
  })

  // Write archive to disk
  core.info('Writing archive to disk')
  const uniqueId = uuid()
  const archivePath = path.join(repositoryPath, `${uniqueId}.tar.gz`)
  await fs.promises.writeFile(archivePath, archiveData)
  archiveData = Buffer.from('') // Free memory

  // Extract archive
  core.info('Extracting the archive')
  const extractPath = path.join(repositoryPath, uniqueId)
  await io.mkdirP(extractPath)
  if (IS_WINDOWS) {
    await toolCache.extractZip(archivePath, extractPath)
  } else {
    await toolCache.extractTar(archivePath, extractPath)
  }
  await io.rmRF(archivePath)

  // Determine the path of the repository content. The archive contains
  // a top-level folder and the repository content is inside.
  const archiveFileNames = await fs.promises.readdir(extractPath)
  assert.ok(
    archiveFileNames.length == 1,
    'Expected exactly one directory inside archive'
  )
  const archiveVersion = archiveFileNames[0] // The top-level folder name includes the short SHA
  core.info(`Resolved version ${archiveVersion}`)
  const tempRepositoryPath = path.join(extractPath, archiveVersion)

  // Move the files
  for (const fileName of await fs.promises.readdir(tempRepositoryPath)) {
    const sourcePath = path.join(tempRepositoryPath, fileName)
    const targetPath = path.join(repositoryPath, fileName)
    if (IS_WINDOWS) {
      await io.cp(sourcePath, targetPath, {recursive: true}) // Copy on Windows (Windows Defender may have a lock)
    } else {
      await io.mv(sourcePath, targetPath)
    }
  }
  await io.rmRF(extractPath)

  core.startGroup('开始处理文件')

  if (fsHelper.directoryExistsSync(repositoryPath)) {
    core.info(`文件夹存在，开始处理`)

    const dockerfilePath = path.join(repositoryPath, 'Dockerfile')

    if (fsHelper.fileExistsSync(dockerfilePath)) {
      // 替换文件内容
      core.info(`Dockerfile文件存在，开始替换内容`)

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8')

      let image = 'registry-vpc.cn-hongkong.aliyuncs.com/hongfs/env:';

      fs.writeFileSync(dockerfilePath, dockerfile.replace('ghcr.io/hongfs/env:', image), 'utf8')
    }
  }

  core.endGroup()
}

/**
 * Looks up the default branch name
 */
export async function getDefaultBranch(
  authToken: string,
  owner: string,
  repo: string,
  baseUrl?: string
): Promise<string> {
  return await retryHelper.execute(async () => {
    core.info('Retrieving the default branch name')
    const octokit = github.getOctokit(authToken, {
      baseUrl: getServerApiUrl(baseUrl)
    })
    let result: string
    try {
      // Get the default branch from the repo info
      const response = await octokit.rest.repos.get({owner, repo})
      result = response.data.default_branch
      assert.ok(result, 'default_branch cannot be empty')
    } catch (err) {
      // Handle .wiki repo
      if (
        (err as any)?.status === 404 &&
        repo.toUpperCase().endsWith('.WIKI')
      ) {
        result = 'master'
      }
      // Otherwise error
      else {
        throw err
      }
    }

    // Print the default branch
    core.info(`Default branch '${result}'`)

    // Prefix with 'refs/heads'
    if (!result.startsWith('refs/')) {
      result = `refs/heads/${result}`
    }

    return result
  })
}

async function downloadArchive(
  authToken: string,
  owner: string,
  repo: string,
  ref: string,
  commit: string,
  baseUrl?: string
): Promise<Buffer> {
  const octokit = github.getOctokit(authToken, {
    baseUrl: getServerApiUrl(baseUrl)
  })
  const download = IS_WINDOWS
    ? octokit.rest.repos.downloadZipballArchive
    : octokit.rest.repos.downloadTarballArchive
  const response = await download({
    owner: owner,
    repo: repo,
    ref: commit || ref
  })
  return Buffer.from(response.data as ArrayBuffer) // response.data is ArrayBuffer
}
