import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'

// main.js is guarded by import.meta.url so importing it does not call main().
const { isZipContentType } = await import('./main.js')

// ---------------------------------------------------------------------------
// isZipContentType – unit tests
// ---------------------------------------------------------------------------

describe('isZipContentType', () => {
    test('returns true for application/zip', () => {
        assert.equal(isZipContentType('application/zip'), true)
    })

    test('returns true for application/x-zip-compressed', () => {
        assert.equal(isZipContentType('application/x-zip-compressed'), true)
    })

    test('returns true for application/zip-compressed', () => {
        assert.equal(isZipContentType('application/zip-compressed'), true)
    })

    test('returns true for application/zip with extra parameters', () => {
        assert.equal(isZipContentType('application/zip; charset=utf-8'), true)
    })

    test('returns true regardless of case', () => {
        assert.equal(isZipContentType('Application/Zip'), true)
        assert.equal(isZipContentType('APPLICATION/ZIP'), true)
    })

    // archive: false uploads use application/octet-stream or similar
    test('returns false for application/octet-stream (archive: false direct upload)', () => {
        assert.equal(isZipContentType('application/octet-stream'), false)
    })

    test('returns false for text/plain', () => {
        assert.equal(isZipContentType('text/plain'), false)
    })

    test('returns false for image/png', () => {
        assert.equal(isZipContentType('image/png'), false)
    })

    test('returns false for empty string', () => {
        assert.equal(isZipContentType(''), false)
    })

    test('returns false for null', () => {
        assert.equal(isZipContentType(null), false)
    })

    test('returns false for undefined', () => {
        assert.equal(isZipContentType(undefined), false)
    })
})

// ---------------------------------------------------------------------------
// Download behaviour – integration tests using a real temp directory
// ---------------------------------------------------------------------------

describe('artifact download behaviour', () => {
    let tmpDir

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'))
    })

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    test('non-ZIP artifact (archive: false) is written as a plain file', () => {
        // Simulate what main.js does when isZipFile is false:
        //   fs.writeFileSync(pathname.join(dir, filename), buffer, 'binary')
        const artifactName = 'my-binary'
        const content = 'raw file content'
        const buffer = Buffer.from(content)

        // isZipContentType must return false for a direct-upload content type
        assert.equal(isZipContentType('application/octet-stream'), false)

        const outputPath = path.join(tmpDir, artifactName)
        fs.writeFileSync(outputPath, buffer, 'binary')

        assert.ok(fs.existsSync(outputPath), 'output file should exist')
        assert.equal(fs.readFileSync(outputPath, 'utf8'), content)
    })

    test('ZIP artifact is extracted to the target directory', () => {
        // Build a minimal in-memory zip containing one entry
        const adm = new AdmZip()
        adm.addFile('hello.txt', Buffer.from('hello from zip'))
        const zipBuffer = adm.toBuffer()

        // isZipContentType must return true for application/zip
        assert.equal(isZipContentType('application/zip'), true)

        // Simulate main.js ZIP extraction path (adm-zip branch)
        const adm2 = new AdmZip(zipBuffer)
        adm2.extractAllTo(tmpDir, true)

        const extracted = path.join(tmpDir, 'hello.txt')
        assert.ok(fs.existsSync(extracted), 'extracted file should exist')
        assert.equal(fs.readFileSync(extracted, 'utf8'), 'hello from zip')
    })

    test('skip_unpack with non-ZIP writes file without .zip extension', () => {
        const artifactName = 'my-report'
        const buffer = Buffer.from('report data')
        const isZipFile = isZipContentType('application/octet-stream') // false

        const ext = isZipFile ? '.zip' : ''
        const outputPath = path.join(tmpDir, `${artifactName}${ext}`)
        fs.writeFileSync(outputPath, buffer, 'binary')

        // Should not have .zip extension
        assert.ok(fs.existsSync(path.join(tmpDir, 'my-report')), 'file without extension should exist')
        assert.ok(!fs.existsSync(path.join(tmpDir, 'my-report.zip')), 'file with .zip extension should not exist')
    })

    test('skip_unpack with ZIP writes file with .zip extension', () => {
        const adm = new AdmZip()
        adm.addFile('data.txt', Buffer.from('data'))
        const artifactName = 'my-archive'
        const buffer = adm.toBuffer()
        const isZipFile = isZipContentType('application/zip') // true

        const ext = isZipFile ? '.zip' : ''
        const outputPath = path.join(tmpDir, `${artifactName}${ext}`)
        fs.writeFileSync(outputPath, buffer, 'binary')

        assert.ok(fs.existsSync(path.join(tmpDir, 'my-archive.zip')), 'file with .zip extension should exist')
        assert.ok(!fs.existsSync(path.join(tmpDir, 'my-archive')), 'file without extension should not exist')
    })

    // -------------------------------------------------------------------------
    // URL-based ZIP detection
    // -------------------------------------------------------------------------
    test('URL path ending with .zip is detected as ZIP', () => {
        const blobUrl = 'https://storage.example.com/artifact-sha.zip?sig=abc'
        const urlPath = new URL(blobUrl).pathname.toLowerCase()
        assert.ok(urlPath.endsWith('.zip'), 'URL pathname should end with .zip')
    })

    test('URL path not ending with .zip is not detected as ZIP via URL', () => {
        const blobUrl = 'https://storage.example.com/artifact-sha?sig=abc'
        const urlPath = new URL(blobUrl).pathname.toLowerCase()
        assert.ok(!urlPath.endsWith('.zip'), 'URL pathname should not end with .zip')
    })

    // -------------------------------------------------------------------------
    // Content-Disposition filename extraction
    // -------------------------------------------------------------------------
    test('Content-Disposition filename is used when present', () => {
        // Simulate the filename extraction logic from main.js
        function extractFilename(contentDisposition, fallback) {
            const cdMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
            const rawFilename = cdMatch ? cdMatch[1].replace(/^['"]|['"]$/g, '').trim() : fallback
            return path.basename(rawFilename) || fallback
        }

        assert.equal(extractFilename('attachment; filename="sha"', 'artifact-name'), 'sha')
        assert.equal(extractFilename('attachment; filename=sha', 'artifact-name'), 'sha')
        assert.equal(extractFilename('', 'artifact-name'), 'artifact-name')
    })

    test('path.basename sanitizes path traversal in artifact name', () => {
        const dangerousName = '../../../etc/passwd'
        const safe = path.basename(dangerousName)
        assert.equal(safe, 'passwd')
        // Ensure writing to a tmpDir using the sanitized name stays within tmpDir
        const outputPath = path.join(tmpDir, safe)
        fs.writeFileSync(outputPath, 'data', 'utf8')
        assert.ok(fs.existsSync(outputPath))
    })
})

