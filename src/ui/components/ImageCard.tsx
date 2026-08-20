import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { clipLine } from '../markdown.js';

/**
 * Image/Screenshot preview card.
 * When the agent or a tool references an image (screenshot, photo, diagram), the TUI
 * cannot render pixels — but it CAN show a structured card with file metadata, dimensions
 * (when available), and a clear visual cue so the user knows an image was produced.
 *
 * This replaces the bare `📷 Screenshot: <path>` text line with a proper tool-card-style
 * element that fits the rest of the UI.
 */

export interface ImageInfo {
  /** File path (absolute or relative to workspace) */
  path: string;
  /** Detected MIME type (e.g. 'image/png', 'image/jpeg') */
  mimeType?: string;
  /** Pixel dimensions, if known [width, height] */
  dimensions?: [number, number];
  /** File size in bytes */
  sizeBytes?: number;
  /** Brief description / alt text from the agent */
  caption?: string;
}

/** Format bytes into human-readable string */
function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short MIME to friendly label */
function mimeLabel(mime?: string): string {
  if (!mime) return 'image';
  if (mime.includes('png')) return 'PNG';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'JPEG';
  if (mime.includes('gif')) return 'GIF';
  if (mime.includes('webp')) return 'WebP';
  if (mime.includes('svg')) return 'SVG';
  return mime.replace('image/', '');
}

/** Image preview card — rendered inline in the message list like a ToolCard. */
export function ImageCard({ info, width }: { info: ImageInfo; width: number }) {
  const fileName = info.path.split('/').pop() ?? info.path;
  const sizeLabel = fmtSize(info.sizeBytes);
  const dimLabel = info.dimensions ? `${info.dimensions[0]}×${info.dimensions[1]}` : '';
  const metaParts = [mimeLabel(info.mimeType), dimLabel, sizeLabel].filter(Boolean);
  const metaStr = metaParts.length > 0 ? `(${metaParts.join(' · ')})` : '';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color={theme.accent}>
          {'📷 '}
        </Text>
        <Text bold color={theme.primary}>
          {clipLine(fileName, Math.max(12, width - 20))}
        </Text>
        <Text color={theme.muted}>
          {' '}{metaStr}
        </Text>
      </Text>
      {info.caption ? (
        <Text color={theme.muted}>
          ⎿ {clipLine(info.caption, Math.max(16, width - 2))}
        </Text>
      ) : null}
      <Text color={theme.muted} dimColor>
        ⎿ {clipLine(info.path, Math.max(16, width - 2))}
      </Text>
    </Box>
  );
}

/** Detect whether a tool result or message references an image file.
 *  Returns parsed ImageInfo if the content looks like an image reference, null otherwise. */
export function detectImageRef(content: string, path?: string): ImageInfo | null {
  // Match common image patterns: screenshots, photos, image paths with extensions
  const imgExtRe = /\.(png|jpe?g|gif|webp|svg|bmp)(\s|$|["')\]])/i;
  const hasImageExt = imgExtRe.test(content);
  const isScreenshotMention = /\b(screenshot|screencapture|capture|snapshot)\b/i.test(content);

  if (!hasImageExt && !isScreenshotMention) return null;

  // Try to extract a file path
  const pathMatch = /[^\s"']+\.(png|jpe?g|gif|webp|svg|bmp)/i.exec(content);
  const filePath = pathMatch?.[0] ?? path;

  if (!filePath && !isScreenshotMention) return null;

  return {
    path: filePath ?? (isScreenshotMention ? '(screenshot)' : '(image)'),
    caption: isScreenshotMention && !filePath ? undefined : extractCaption(content),
  };
}

/** Extract a brief caption/description from surrounding text (everything before/after the image ref). */
function extractCaption(content: string): string | undefined {
  // Remove the image path itself and clean up
  const cleaned = content
    .replace(/[^\s"']*\.(png|jpe?g|gif|webp|svg|bmp)/gi, '[image]')
    .replace(/\s*(📷|Screenshot|screenshot|Image)[:\s]*/gi, '')
    .trim();
  return cleaned.length > 2 && cleaned.length < 200 ? cleaned : undefined;
}
