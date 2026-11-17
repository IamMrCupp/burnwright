import { deviceNotices } from "../../lib/firmware";
import type { AlgorithmFile, DeviceInfo } from "../../lib/engine";
import "./DeviceNotices.css";

export interface DeviceNoticesProps {
  device: DeviceInfo;
  /** Where a T76's `algorithm.xml` stands, when that's known. */
  algorithms?: AlgorithmFile | null;
}

/**
 * What minipro warned about when it found the programmer: firmware that's
 * out of date (worth acting on) or newer than expected, and its own note on
 * how well it supports the model. A T76 with no algorithm file is said here
 * too, before an operation fails for want of it. Renders nothing when
 * there's nothing to say.
 */
export function DeviceNotices({ device, algorithms = null }: DeviceNoticesProps) {
  const notices = deviceNotices(device, algorithms);
  if (notices.length === 0) return null;
  return (
    <section className="device-notices" aria-label="Notes about this programmer">
      {notices.map((notice) => (
        <article
          key={notice.title}
          className={`device-notice device-notice-${notice.severity}`}
          // A warning is announced; a note isn't worth interrupting for.
          role={notice.severity === "warning" ? "alert" : undefined}
        >
          <h3>
            <span className="device-notice-tag">
              {notice.severity === "warning" ? "Warning" : "Note"}
            </span>{" "}
            {notice.title}
          </h3>
          <p>{notice.detail}</p>
        </article>
      ))}
    </section>
  );
}
