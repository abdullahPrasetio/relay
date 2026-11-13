import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';

const CARD_WIDTH = 348;
const MARGIN = 12;
const GAP = 14;

function visible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findAnchor(step) {
  const selectors = Array.isArray(step?.anchor) ? step.anchor : [step?.anchor];
  for (const selector of selectors) {
    if (!selector) continue;
    const element = document.querySelector(selector);
    if (visible(element)) return element;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function placeCard(rect, height, preferred) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const order = [...new Set([preferred, 'bottom', 'top', 'right', 'left'].filter(Boolean))];
  for (const side of order) {
    if (side === 'bottom') {
      const top = rect.bottom + GAP;
      if (top + height <= vh - MARGIN) {
        return {
          side,
          left: clamp(rect.left + rect.width / 2 - CARD_WIDTH / 2, MARGIN, vw - CARD_WIDTH - MARGIN),
          top,
        };
      }
    }
    if (side === 'top') {
      const top = rect.top - GAP - height;
      if (top >= MARGIN) {
        return {
          side,
          left: clamp(rect.left + rect.width / 2 - CARD_WIDTH / 2, MARGIN, vw - CARD_WIDTH - MARGIN),
          top,
        };
      }
    }
    if (side === 'right') {
      const left = rect.right + GAP;
      if (left + CARD_WIDTH <= vw - MARGIN) {
        return {
          side,
          left,
          top: clamp(rect.top + rect.height / 2 - height / 2, MARGIN, vh - height - MARGIN),
        };
      }
    }
    if (side === 'left') {
      const left = rect.left - GAP - CARD_WIDTH;
      if (left >= MARGIN) {
        return {
          side,
          left,
          top: clamp(rect.top + rect.height / 2 - height / 2, MARGIN, vh - height - MARGIN),
        };
      }
    }
  }
  return null;
}

function arrowPosition(rect, card, side) {
  if (side === 'bottom' || side === 'top') {
    return {
      left: clamp(rect.left + rect.width / 2 - card.left - 6, 18, CARD_WIDTH - 30),
      top: side === 'bottom' ? -6 : card.height - 6,
      rotate: side === 'bottom' ? '45deg' : '225deg',
    };
  }
  return {
    left: side === 'right' ? -6 : card.width - 6,
    top: clamp(rect.top + rect.height / 2 - card.top - 6, 18, card.height - 30),
    rotate: side === 'right' ? '-45deg' : '135deg',
  };
}

export default function FeatureTour({
  step,
  index,
  total,
  onNext,
  onBack,
  onSkipStep,
  onSkipTour,
}) {
  const [rect, setRect] = useState(null);
  const [fallback, setFallback] = useState(false);
  const [cardHeight, setCardHeight] = useState(218);
  const cardRef = useRef(null);
  const stepId = step?.id;

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let attempts = 0;
    let element = null;

    const measure = () => {
      if (cancelled) return;
      element = findAnchor(step);
      if (element) {
        const box = element.getBoundingClientRect();
        setRect({
          top: box.top,
          left: box.left,
          width: box.width,
          height: box.height,
          bottom: box.bottom,
          right: box.right,
        });
        setFallback(false);
        return;
      }
      attempts += 1;
      if (attempts < 12) {
        timer = setTimeout(measure, 80);
        return;
      }
      if (step.skipIfMissing) {
        onSkipStep?.();
      } else {
        setRect(null);
        setFallback(true);
      }
    };

    const anchor = findAnchor(step);
    if (anchor) anchor.scrollIntoView({ block: 'center', inline: 'center' });
    const frame = requestAnimationFrame(measure);

    const reposition = () => {
      if (!element || cancelled) return;
      const box = element.getBoundingClientRect();
      setRect({
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        bottom: box.bottom,
        right: box.right,
      });
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
    // The step object is replaced only when the queue advances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight || 218);
  }, [stepId, fallback, rect?.top, rect?.left]);

  useEffect(() => {
    cardRef.current?.focus?.();
  }, [stepId]);

  if (!step) return null;

  const card = rect && !fallback
    ? placeCard(rect, cardHeight, step.placement)
    : null;
  const cardStyle = card
    ? { left: `${card.left}px`, top: `${card.top}px`, width: `${CARD_WIDTH}px` }
    : { left: '50%', top: '50%', width: `${CARD_WIDTH}px`, transform: 'translate(-50%, -50%)' };
  const arrow = card ? arrowPosition(rect, { ...card, height: cardHeight, width: CARD_WIDTH }, card.side) : null;
  const effectiveFallback = fallback || Boolean(rect && !card);
  const dots = Math.min(total, 8);

  return createPortal(
    <>
      {rect && !fallback && (
        <>
          <div
            className="feature-tour-spot"
            style={{
              left: `${rect.left - 3}px`,
              top: `${rect.top - 3}px`,
              width: `${rect.width + 6}px`,
              height: `${rect.height + 6}px`,
            }}
          />
          {arrow && (
            <div
              className="feature-tour-arrow"
              style={{
                left: `${card.left + arrow.left}px`,
                top: `${card.top + arrow.top}px`,
                transform: `rotate(${arrow.rotate})`,
              }}
            />
          )}
        </>
      )}
      {effectiveFallback && <div className="feature-tour-backdrop" />}
      <div
        ref={cardRef}
        className="feature-tour-card"
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`feature-tour-title-${step.id}`}
        tabIndex={-1}
        data-testid="feature-tour"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onSkipStep?.();
            return;
          }
          if (event.key === 'Tab') {
            const buttons = [...cardRef.current.querySelectorAll('button:not(:disabled)')];
            if (buttons.length === 0) return;
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="feature-tour-accent" />
        <div className="feature-tour-body">
          <div className="feature-tour-top">
            <span className="feature-tour-kicker">{step.group || 'Relay'}</span>
            <span className="feature-tour-count">
              {index + 1} of {total}
            </span>
            <button
              type="button"
              className="feature-tour-close"
              data-testid="feature-tour-skip-step"
              title="Skip this tip"
              aria-label="Skip this tip"
              onClick={onSkipStep}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          <h3 id={`feature-tour-title-${step.id}`}>{step.title}</h3>
          <p>{step.body}</p>
          {step.hint && <div className="feature-tour-hint">{step.hint}</div>}
        </div>
        <div className="feature-tour-foot">
          <div className="feature-tour-dots" aria-hidden="true">
            {Array.from({ length: dots }).map((_, dot) => (
              <span
                key={dot}
                className={`feature-tour-dot${dot <= index % dots ? ' on' : ''}`}
              />
            ))}
          </div>
          <button type="button" className="feature-tour-skip" data-testid="feature-tour-skip" onClick={onSkipTour}>
            Skip tour
          </button>
          <button
            type="button"
            className="mini-btn"
            data-testid="feature-tour-back"
            disabled={index === 0}
            onClick={onBack}
          >
            Back
          </button>
          <button type="button" className="send-btn feature-tour-next" data-testid="feature-tour-next" onClick={onNext}>
            {index + 1 === total ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
