/**
 * Markdown generation for Linear issues
 * Generates markdown files in the specified template format
 */

import { writeFileSync } from 'fs'
import { join, extname } from 'path'
import type { LinearIssue as Issue, LinearAttachment } from '../types/workspace'
import { logger } from './logger.js'

/**
 * Convert a string to kebab-case for branch names
 */
function toKebabCase(str: string, maxLength = 60): string {
	const kebab = str
		.toLowerCase()
		.replace(/[^\w\s-]/g, '') // Remove special chars
		.replace(/\s+/g, '-') // Replace spaces with dashes
		.replace(/-+/g, '-') // Collapse multiple dashes
		.replace(/^-|-$/g, '') // Remove leading/trailing dashes

	// Truncate to max length at word boundary
	if (kebab.length <= maxLength) {
		return kebab
	}

	const truncated = kebab.substring(0, maxLength)
	const lastDash = truncated.lastIndexOf('-')

	return lastDash > 0 ? truncated.substring(0, lastDash) : truncated
}

/**
 * Clean markdown text to plaintext while preserving structure
 * Keeps lists and code fences readable
 */
function cleanMarkdown(text: string): string {
	// For now, just return the text as-is
	// More sophisticated markdown-to-plaintext conversion can be added later
	return text.trim()
}

/**
 * Download an image from a URL and save it to disk
 * Supports authenticated Linear image downloads
 */
async function downloadImage(
	url: string,
	filepath: string,
	linearApiKey?: string
): Promise<void> {
	try {
		// Check if this is a Linear upload URL that requires authentication
		const isLinearUpload = url.includes('uploads.linear.app')

		// Prepare fetch options
		const fetchOptions: RequestInit = {}

		if (isLinearUpload && linearApiKey) {
			// Linear API keys (lin_api_...) don't use Bearer prefix
			// Only OAuth tokens use Bearer prefix
			const authHeader = linearApiKey.startsWith('lin_api_')
				? linearApiKey
				: `Bearer ${linearApiKey}`

			fetchOptions.headers = {
				Authorization: authHeader,
			}
		}

		const response = await fetch(url, fetchOptions)

		if (!response.ok) {
			throw new Error(
				`Failed to download image: ${response.status} ${response.statusText}`
			)
		}

		const arrayBuffer = await response.arrayBuffer()
		const buffer = Buffer.from(arrayBuffer)

		writeFileSync(filepath, buffer)
		logger.debug(`Downloaded image: ${url} -> ${filepath}`)
	} catch (error) {
		logger.warning(
			`Failed to download image from ${url}: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`
		)
		throw error
	}
}

/**
 * Get file extension from URL or default to .png
 */
function getExtensionFromUrl(url: string): string {
	try {
		const urlObj = new URL(url)
		const pathname = urlObj.pathname
		const ext = extname(pathname)

		// Common image extensions
		if (
			['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(
				ext.toLowerCase()
			)
		) {
			return ext.toLowerCase()
		}
	} catch {
		// Invalid URL, fall through to default
	}

	return '.png'
}

/**
 * Download and localize images in markdown and from attachments
 * Replaces image URLs with local file paths
 */
async function downloadAndLocalizeImages(
	description: string,
	attachments: LinearAttachment[],
	promptDir: string,
	linearApiKey?: string
): Promise<string> {
	let localizedDescription = description
	let imageCounter = 1

	// Regular expression to match markdown images: ![alt](url)
	const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g

	// Extract all image URLs from markdown
	const imageMatches = Array.from(description.matchAll(imageRegex))

	// Download images from markdown description
	for (const match of imageMatches) {
		const [fullMatch, altText, imageUrl] = match

		try {
			const ext = getExtensionFromUrl(imageUrl)
			const filename = `image-${imageCounter}${ext}`
			const filepath = join(promptDir, filename)

			await downloadImage(imageUrl, filepath, linearApiKey)

			// Replace URL with local path in markdown
			localizedDescription = localizedDescription.replace(
				fullMatch,
				`![${altText}](./${filename})`
			)

			imageCounter++
		} catch (error) {
			logger.warning(`Skipping image: ${imageUrl}`)
			// Keep original URL if download fails
		}
	}

	// Download images from Linear attachments (if they're image URLs)
	for (const attachment of attachments) {
		// Check if attachment is an image based on URL
		const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(attachment.url)

		if (isImage) {
			try {
				const ext = getExtensionFromUrl(attachment.url)
				const filename = `attachment-${imageCounter}${ext}`
				const filepath = join(promptDir, filename)

				await downloadImage(attachment.url, filepath, linearApiKey)

				// Add attachment to markdown if not already present
				const attachmentTitle = attachment.title || `Attachment ${imageCounter}`
				const attachmentMarkdown = `\n\n![${attachmentTitle}](./${filename})`

				// Only add if this URL isn't already in the description
				if (!description.includes(attachment.url)) {
					localizedDescription += attachmentMarkdown
				}

				imageCounter++
			} catch (error) {
				logger.warning(`Skipping attachment: ${attachment.url}`)
			}
		}
	}

	return localizedDescription
}

/**
 * Generate markdown content for an issue
 * Follows the exact template format from the specification
 *
 * @param issue - The issue to generate markdown for
 * @param promptDir - Directory where images will be saved (optional, if provided downloads images)
 * @param linearApiKey - Linear API key for authenticated image downloads (optional)
 * @returns Markdown formatted string
 */
export async function generateMarkdown(
	issue: Issue,
	promptDir?: string,
	linearApiKey?: string
): Promise<string> {
	const assignee = await issue.assignee
	const state = await issue.state

	const assigneeName = assignee?.name || 'unassigned'

	let description = issue.description || 'No description provided.'

	// Download and localize images if promptDir is provided
	if (promptDir && issue.description) {
		try {
			// Fetch attachments (lazy-loaded - only called when needed)
			const attachments = await issue.attachments()

			description = await downloadAndLocalizeImages(
				issue.description,
				attachments,
				promptDir,
				linearApiKey
			)
		} catch (error) {
			logger.warning('Failed to download some images, using original URLs')
		}
	}

	const fullDescription = cleanMarkdown(description)
	const branchName = `${issue.identifier}-${toKebabCase(issue.title)}`

	return `# ${issue.identifier}: ${issue.title}

**linear url:** ${issue.url}
**assignee:** ${assigneeName}
**state:** ${state?.name ?? 'Unknown'}

## description

${fullDescription}

## acceptance criteria (fill in)

- [ ] criterion 1
- [ ] criterion 2

## implementation notes (auto-generated)

- branch name: \`${branchName}\`
- source issue id: \`${issue.id}\`
`
}
