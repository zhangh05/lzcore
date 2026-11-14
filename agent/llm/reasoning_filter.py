"""Incremental public-text projection; native provider content stays private."""

from __future__ import annotations

import re


class ReasoningFilter:
    """Hide tagged reasoning, including incomplete tags across stream chunks.

    Markdown fenced/inline code, escaped tags and block quotes are literal
    examples. Inside a private segment only matching tags affect visibility.
    """

    _tag = re.compile(r"</?(think|reasoning)\b[^>]*>", re.IGNORECASE)

    def __init__(self):
        self._pending = ""
        self._private: list[str] = []
        self._code = ""
        self._fence = ""
        self._line_start = True
        self._quote = False
        self._escaped = False
        self.stripped = False

    def feed(self, text: str, *, final: bool = False) -> str:
        self._pending += text
        output = []
        i = 0
        while i < len(self._pending):
            char = self._pending[i]
            if not self._private and char in "`~" and not self._escaped and not self._quote:
                rest = self._pending[i:]
                run = len(rest) - len(rest.lstrip(char))
                if run == len(rest) and not final:
                    break
                marker = char * run
                if self._fence:
                    if self._line_start and char == self._fence[0] and run >= len(self._fence):
                        self._fence = ""
                elif self._code:
                    if marker == self._code:
                        self._code = ""
                elif self._line_start and run >= 3:
                    self._fence = marker
                elif char == "`":
                    self._code = marker
                output.append(marker)
                self._line_start = False
                i += run
                continue
            literal = bool(self._fence or self._code or self._quote or self._escaped)
            if char == "<" and (self._private or not literal):
                rest = self._pending[i:]
                lower = rest.lower()
                names = ("<think", "</think", "<reasoning", "</reasoning")
                possible = any(name.startswith(lower) or (
                    lower.startswith(name) and (len(lower) == len(name) or lower[len(name)] in " \t\r\n/>")
                ) for name in names)
                if possible:
                    end = rest.find(">")
                    if end < 0:
                        if not final:
                            break
                        self.stripped = True
                        i = len(self._pending)
                        continue
                    match = self._tag.fullmatch(rest[:end + 1])
                    if match:
                        name = match.group(1).lower()
                        if rest.startswith("</"):
                            if self._private and self._private[-1] == name:
                                self._private.pop()
                        else:
                            self._private.append(name)
                        self.stripped = True
                        i += end + 1
                        continue
            if self._private:
                self.stripped = True
            else:
                output.append(char)
                if char == "\n":
                    self._line_start = True
                    self._quote = False
                elif self._line_start and char == ">":
                    self._quote = True
                    self._line_start = False
                elif char not in " \t\r":
                    self._line_start = False
                self._escaped = char == "\\" and not self._escaped
            i += 1
        self._pending = self._pending[i:]
        return "".join(output)
