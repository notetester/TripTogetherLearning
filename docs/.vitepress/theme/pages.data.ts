import { createContentLoader } from 'vitepress'

// 모든 학습 페이지의 frontmatter(owner/domain/tags)를 빌드 타임에 수집.
// owner 가 지정된 페이지만 "담당별 보기" 필터 대상이 된다.
export default createContentLoader('**/*.md', {
  includeSrc: true,
  transform(raw) {
    return raw
      .filter((p) => p.frontmatter && p.frontmatter.owner)
      .map((p) => {
        const m = (p.src || '').match(/^#\s+(.+?)\s*$/m)
        const title = p.frontmatter.title || (m ? m[1].trim() : p.url)
        return {
          url: p.url,
          title,
          owner: String(p.frontmatter.owner || ''),
          domain: String(p.frontmatter.domain || ''),
          tags: Array.isArray(p.frontmatter.tags) ? p.frontmatter.tags : [],
        }
      })
      .sort((a, b) => a.url.localeCompare(b.url))
  },
})
