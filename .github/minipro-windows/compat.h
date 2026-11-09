/*
 * Build glue for compiling upstream minipro with MinGW-w64 (see
 * .github/workflows/minipro-windows.yml). Force-included with
 * `-include`, so vendor/minipro stays unpatched.
 *
 * MinGW-w64's CRT headers don't declare POSIX stpcpy(), which
 * src/database.c uses. GCC 14+ makes implicit declarations a hard error.
 * Candidate upstream fix: guard a local stpcpy() in database.c with
 * #ifdef _WIN32, or replace the call with strcpy() + strlen().
 */
#ifndef BURNWRIGHT_MINIPRO_COMPAT_H
#define BURNWRIGHT_MINIPRO_COMPAT_H

#ifdef _WIN32
#include <string.h>

static inline char *burnwright_stpcpy(char *dst, const char *src)
{
	size_t n = strlen(src);
	memcpy(dst, src, n + 1);
	return dst + n;
}
#define stpcpy burnwright_stpcpy
#endif

#endif
