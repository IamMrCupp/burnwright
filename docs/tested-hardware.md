# Tested hardware

What burnwright has done to real chips on real programmers, and who checked.
Every row comes from a
[hardware test report](https://github.com/IamMrCupp/burnwright/issues/new?template=hardware-test.yml)
and links to it. How to run a test is in
[testing-on-hardware.md](testing-on-hardware.md).

Not being listed doesn't mean it doesn't work. minipro supports thousands of
chips. This is only the set someone has confirmed through burnwright.

## Programmers

"Works" means burnwright found the programmer and finished at least one chip
operation that checked out. A dash means nobody's reported either way.

| Programmer | macOS | Linux | Windows |
|---|---|---|---|
| TL866A / TL866CS | - | - | - |
| TL866II+ | - | - | - |
| T48 | - | - | - |
| T56 | - | - | - |
| T76 | - | - | - |

## Chips

"Read" means the file matched a read by another tool. "Write" means another
tool read back what burnwright wrote. A dash means it wasn't tried.

| Chip | Programmer | OS | burnwright | Read | Write | Report | Tested by |
|---|---|---|---|---|---|---|---|

No reports yet. Yours could be the first row.

## Adding a row

File the report. Once it's been read, the row goes in with a link to the
issue and your name, unless you asked to be left out. A report that found a
bug gets its row when the fix ships, against the version that fixed it.
