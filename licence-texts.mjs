// Licence texts for bundled packages that ship no licence file. MIT and BSD require the copyright
// notice and the permission text to travel with the code, so build.mjs takes the text from here.
// Each entry names where its copyright line was read. A bundled package with neither a licence
// file nor an entry here fails the build. Keys are package names; `licence` must equal the
// licence the package declares.

const MIT = (copyright) => `The MIT License (MIT)

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`

// The text of the header comment in esrecurse.js, which is the package's own statement of its licence.
const BSD_2_CLAUSE = `Copyright (C) 2014 Yusuke Suzuki <utatane.tea@gmail.com>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`

export const SUPPLIED = {
  esrecurse: { licence: 'BSD-2-Clause', source: 'header comment of esrecurse.js', text: BSD_2_CLAUSE },
  imurmurhash: {
    licence: 'MIT',
    source: 'the License section of the package README',
    text: MIT('Copyright (c) 2013 Gary Court, Jens Taylor'),
  },
  keyv: {
    licence: 'MIT',
    source: 'the License section of the package README ("MIT (c) Jared Wray"; it states no year)',
    text: MIT('Copyright (c) Jared Wray'),
  },
  'natural-compare': {
    licence: 'MIT',
    source: 'the Licence section of the package README',
    text: MIT('Copyright (c) 2012-2015 Lauri Rooden <lauri@rooden.ee>'),
  },
}
