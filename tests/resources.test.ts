import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/indexer.js';

describe('Android resource text', () => {
  it('indexes processed strings, plurals and arrays in document order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-resources-'));
    try {
      const dir = join(root, 'app/src/main/res/values');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'strings.xml'), String.raw`<resources>
        <string name="escaped">It\'s \"ready\"\nnext\t\u0041\\</string>
        <string name="whitespace">  A   line
          with   space  </string>
        <string name="quoted">"  keep   space  "</string>
        <string name="markup">Hello <b>bold <i>and</i> bright</b> &amp; <![CDATA[clear]]> end</string>
        <string name="format">Count:\n%1$d</string>
        <plurals name="items"><item quantity="one">One <b>item</b></item><item quantity="other">%d items</item></plurals>
        <string-array name="choices"><item>First <b>choice</b></item><item>"  Second  "</item></string-array>
      </resources>`);
      const { resources } = await buildIndex(root);
      const value = (key: string) => resources.find(entry => entry.key === key)?.value;
      expect(value('escaped')).toBe('It\'s "ready"\nnext\tA\\');
      expect(value('whitespace')).toBe('A line with space');
      expect(value('quoted')).toBe('  keep   space  ');
      expect(value('markup')).toBe('Hello bold and bright & clear end');
      const regex = resources.find(entry => entry.key === 'format')?.regex;
      expect(regex).toBeDefined();
      expect('Count:\n12').toMatch(new RegExp(regex!));
      expect(resources.find(entry => entry.key === 'items' && entry.quantity === 'one')?.value).toBe('One item');
      expect(resources.find(entry => entry.key === 'choices' && entry.index === 0)?.value).toBe('First choice');
      expect(resources.find(entry => entry.key === 'choices' && entry.index === 1)?.value).toBe('  Second  ');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
