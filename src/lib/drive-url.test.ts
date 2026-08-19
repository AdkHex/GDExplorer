import { describe, it, expect } from 'vitest'
import { extractDriveFolderId } from './drive-url'

const ID = '1AbC_dEfGhIjKlMnOpQrStUvWxYz09'
const SHARED_DRIVE_ID = '0AHxYzAbCdEfGhIjKlM'

describe('extractDriveFolderId', () => {
  it('extracts from a plain folder URL', () => {
    expect(
      extractDriveFolderId(`https://drive.google.com/drive/folders/${ID}`)
    ).toBe(ID)
  })

  it('extracts from a user-scoped folder URL', () => {
    expect(
      extractDriveFolderId(`https://drive.google.com/drive/u/0/folders/${ID}`)
    ).toBe(ID)
  })

  it('extracts from a shared-drive URL', () => {
    expect(
      extractDriveFolderId(
        `https://drive.google.com/drive/u/0/shared-drives/${SHARED_DRIVE_ID}`
      )
    ).toBe(SHARED_DRIVE_ID)
    expect(
      extractDriveFolderId(
        `https://drive.google.com/drive/shared-drives/${SHARED_DRIVE_ID}`
      )
    ).toBe(SHARED_DRIVE_ID)
  })

  it('ignores query strings and trailing slashes', () => {
    expect(
      extractDriveFolderId(
        `https://drive.google.com/drive/folders/${ID}?usp=sharing`
      )
    ).toBe(ID)
    expect(
      extractDriveFolderId(`https://drive.google.com/drive/folders/${ID}/`)
    ).toBe(ID)
  })

  it('extracts from an /open?id= URL', () => {
    expect(extractDriveFolderId(`https://drive.google.com/open?id=${ID}`)).toBe(
      ID
    )
  })

  it('accepts a bare folder ID', () => {
    expect(extractDriveFolderId(ID)).toBe(ID)
    expect(extractDriveFolderId(`  ${SHARED_DRIVE_ID}  `)).toBe(SHARED_DRIVE_ID)
  })

  it('rejects file URLs', () => {
    expect(
      extractDriveFolderId(`https://drive.google.com/file/d/${ID}/view`)
    ).toBeNull()
  })

  it('rejects other hosts and non-http protocols', () => {
    expect(
      extractDriveFolderId(`https://evil.example.com/drive/folders/${ID}`)
    ).toBeNull()
    expect(
      extractDriveFolderId(`ftp://drive.google.com/drive/folders/${ID}`)
    ).toBeNull()
  })

  it('rejects empty, short, and malformed input', () => {
    expect(extractDriveFolderId('')).toBeNull()
    expect(extractDriveFolderId('   ')).toBeNull()
    expect(extractDriveFolderId('short')).toBeNull()
    expect(extractDriveFolderId('not a url at all')).toBeNull()
    expect(
      extractDriveFolderId('https://drive.google.com/drive/my-drive')
    ).toBeNull()
  })
})
