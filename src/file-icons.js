import { svgIcon } from './dom.js'

/* The same marks appear in the file tree, switcher, and Copilot attachment
   cards. Keeping the paths here prevents those surfaces from inventing their
   own version of what a Markdown note, PDF, or whiteboard looks like. */
const FILE_ICONS = {
  note: `<rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.2" fill="none"
           stroke="#519ABA" stroke-width="1.7"/>
         <path d="M6.2 15.4V8.6l2.8 3.4 2.8-3.4v6.8M15.4 8.6v4.4M13.2 11.4l2.2 2.4 2.2-2.4"
           fill="none" stroke="#519ABA" stroke-width="1.7"
           stroke-linecap="round" stroke-linejoin="round"/>`,
  language: `<rect x="3" y="4.2" width="18" height="15.6" rx="2.2" fill="none"
              stroke="#8E67C7" stroke-width="1.7"/>
             <path d="M3 9.3h18M9 4.2v15.6M15 4.2v15.6"
              fill="none" stroke="#8E67C7" stroke-width="1.35"/>
             <path d="M4.8 14.4h2.4M10.8 14.4h2.4M16.8 14.4h2.4"
              stroke="#8E67C7" stroke-width="1.35" stroke-linecap="round"/>`,
  file: `<path d="M6.4 2.6h6.6L19 8.6V20a1.6 1.6 0 0 1-1.6 1.6H6.4A1.6 1.6 0 0 1 4.8 20V4.2a1.6 1.6 0 0 1 1.6-1.6z"
          fill="#8A93A5"/>
        <path d="M13 2.6 19 8.6h-4.4A1.6 1.6 0 0 1 13 7z" fill="#fff" fill-opacity=".42"/>
        <path d="M8 13h8M8 16h5" stroke="#fff" stroke-width="1.35"
          stroke-linecap="round" opacity=".9"/>`,
  pdf: `<path d="M6.4 2.6h6.6L19 8.6V20a1.6 1.6 0 0 1-1.6 1.6H6.4A1.6 1.6 0 0 1 4.8 20V4.2a1.6 1.6 0 0 1 1.6-1.6z"
          fill="#E8554B"/>
        <path d="M13 2.6 19 8.6h-4.4a1.6 1.6 0 0 1-1.6-1.6z" fill="#fff" fill-opacity=".38"/>
        <path d="M7.9 12.6h8.2M7.9 15.4h5.6" stroke="#fff" stroke-width="1.5"
          stroke-linecap="round" opacity=".95"/>`,
  tex: `<path d="M5 3.2h14v17.6H5z" fill="none" stroke="#43A5A1" stroke-width="1.6"/>
        <path d="M7.5 8h9M8.2 11.2h7.6M7.4 15.8l2.1-2.1 2.1 2.1M14 13.7h2.5"
          fill="none" stroke="#43A5A1" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>`,
  site: `<circle cx="12" cy="12" r="8.4" fill="none" stroke="#3C87C4" stroke-width="1.7"/>
         <path d="M3.6 12h16.8" fill="none" stroke="#3C87C4" stroke-width="1.5"/>
         <path d="M12 3.6c2.4 2.3 3.6 5.1 3.6 8.4s-1.2 6.1-3.6 8.4c-2.4-2.3-3.6-5.1-3.6-8.4S9.6 5.9 12 3.6z"
           fill="none" stroke="#3C87C4" stroke-width="1.5"/>`,
  whiteboard: `<rect x="3" y="3" width="18" height="18" rx="3" fill="#F4D06F"
                fill-opacity=".28" stroke="#C38B16" stroke-width="1.6"/>
               <path d="M6.3 16.8c1.5-4.6 3.2-7 5-7 2.1 0 1.4 5.2 3.2 5.2 1 0 1.9-1.3 3.2-4"
                fill="none" stroke="#C38B16" stroke-width="1.8" stroke-linecap="round"/>
               <circle cx="7" cy="7" r="1.3" fill="#C38B16"/>`,
  video: `<rect x="3" y="5" width="18" height="14" rx="2.5" fill="#6D70C9"/>
          <path d="m10 8.3 5.2 3.7-5.2 3.7z" fill="#fff" fill-opacity=".9"/>`,
  audio: `<circle cx="12" cy="12" r="9" fill="#D88745"/>
          <path d="M7 12v2M10 9v6M13 7v10M16 10v4" stroke="#fff" stroke-width="1.5"
            stroke-linecap="round" opacity=".92"/>`
}

/** The tile for a file of this kind, or the plain one when it is not a kind
 *  this list knows. A fresh element each time, so every caller is free to
 *  append what it gets — `svgIcon` parses each shape once and clones it, which
 *  is what makes a sidebar of a thousand rows cheap. */
export function fileIcon (kind) {
  return svgIcon(FILE_ICONS[kind] || FILE_ICONS.file,
    { viewBox: '0 0 24 24', className: 'file-ico' })
}
