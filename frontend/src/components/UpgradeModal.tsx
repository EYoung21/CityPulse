"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import UpgradePrompt from "@/components/UpgradePrompt";

interface UpgradeModalProps {
  feature: string;
  description: string;
  onClose: () => void;
}

/** Accessible modal shell for upgrade requests raised from map surfaces.
 * Base UI supplies focus placement/trapping, Escape handling, outside-click
 * dismissal, and the dialog relationship announced by screen readers. */
export default function UpgradeModal({
  feature,
  description,
  onClose,
}: UpgradeModalProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-modal="true"
        showCloseButton={false}
        overlayClassName="z-[9998] bg-black/60 backdrop-blur-sm"
        className="z-[9999] max-w-[calc(100%-2rem)] bg-transparent p-0 ring-0 sm:max-w-[360px]"
      >
        <DialogTitle className="sr-only">Unlock {feature}</DialogTitle>
        <UpgradePrompt
          feature={feature}
          description={description}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
