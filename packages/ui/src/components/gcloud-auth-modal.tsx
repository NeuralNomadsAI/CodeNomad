import { Component } from "solid-js"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui"
import { Button } from "./ui"

interface GCloudAuthModalProps {
  open: boolean
  onClose: () => void
  mode?: "setup" | "expired" | "refresh"
}

const GCloudAuthModal: Component<GCloudAuthModalProps> = (props) => {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Google Cloud Authentication</DialogTitle>
        </DialogHeader>

        <div class="space-y-2">
          <p class="text-sm text-muted-foreground">
            Google Cloud authentication is not yet available.
          </p>
          <p class="text-xs text-muted-foreground">
            This feature will enable Vertex AI integration, cloud infrastructure management,
            and other Google Cloud services. Check back in a future release.
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={props.onClose}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default GCloudAuthModal
