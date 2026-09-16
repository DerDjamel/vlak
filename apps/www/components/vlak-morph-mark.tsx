import styles from "./vlak-morph-mark.module.css";

const noord = "M411 0L539 128 539 310 629 219 822 411 693 540 539 386 539 694 411 822 283 694 283 386 129 540 0 411 283 128Z";
// Reverse the reflected outline to retain its winding during interpolation.
const vlak = "M411 822L283 694 0 411 129 282 283 436 283 128 411 0 539 128 539 436 693 282 822 411 629 603 539 512 539 694Z";

export function VlakMorphMark() {
  return <svg viewBox="0 0 822 822" fill="currentColor" aria-hidden="true" className="site-logo-mark">
    <path className={styles.still} d={vlak}/>
    <path className={styles.motion} d={vlak}>
      <animate attributeName="d" values={[noord,noord,vlak,vlak,noord,noord,vlak,vlak,noord,noord,vlak].join(";")} keyTimes="0;.06;.19;.29;.38;.42;.55;.65;.74;.78;1" dur="10s" repeatCount="1" fill="freeze" calcMode="spline" keySplines={Array(10).fill("0.65 0 0.25 1").join(";")}/>
    </path>
  </svg>;
}
