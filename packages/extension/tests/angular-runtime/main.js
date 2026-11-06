// Real JIT Angular/Material fixture; no private Angular view traversal.
import 'zone.js';
import '@angular/compiler';
import { Component, Directive, Input, ViewChild, ViewContainerRef, inject, ChangeDetectionStrategy, ViewEncapsulation, enableProdMode, forwardRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, RouterOutlet } from '@angular/router';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal, TemplatePortal } from '@angular/cdk/portal';
import { SameComponent as SameA } from './same-a.js';
import { SameComponent as SameB } from './same-b.js';

class ShadowComponent {}
Component({ selector: 'fixture-shadow', standalone: true, encapsulation: ViewEncapsulation.ShadowDom, template: '<button>First</button><button>Second</button>' })(ShadowComponent);
window.inputReads = 0;
class MarkerDirective {}
Directive({ selector: '[fixtureMarker]', standalone: true })(MarkerDirective);
class CardComponent {
  get secret() { window.inputReads++; return 'DO_NOT_COLLECT'; }
  set secret(value) {}
}
Input('publicSecret')(CardComponent.prototype, 'secret');
Component({ selector: 'fixture-card', standalone: true, imports: [CommonModule, MarkerDirective, MatTooltipModule], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button data-testid="card-action" fixtureMarker matTooltip="Help" type="button">Card action</button><button *ngIf="true" data-testid="conditional">Conditional</button><span *ngFor="let item of [1,2]" data-testid="repeated">Repeated</span><ng-content></ng-content>` })(CardComponent);
class RecursiveComponent { depth = 0; }
Input()(RecursiveComponent.prototype, 'depth');
Component({ selector: 'fixture-recursive', standalone: true, imports: [CommonModule, forwardRef(() => RecursiveComponent)],
  template: `<span [attr.data-testid]="'recursive-' + depth">Recursive</span><fixture-recursive *ngIf="depth < 2" [depth]="depth + 1"></fixture-recursive>` })(RecursiveComponent);
class PortalComponent {}
Component({ selector: 'fixture-portal', standalone: true, template: '<button data-testid="component-portal">Portal</button>' })(PortalComponent);
class NestedDialogComponent {}
Component({ selector: 'fixture-nested-dialog', standalone: true, template: '<button data-testid="nested-dialog">Nested</button>' })(NestedDialogComponent);
class DialogComponent {
  dialog = inject(MatDialog);
  openNested() { this.dialog.open(NestedDialogComponent, { autoFocus: false }); }
}
Component({ selector: 'fixture-dialog', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<button data-testid="dialog-action" (click)="openNested()">Dialog action</button>' })(DialogComponent);
class AppComponent {
  dialog = inject(MatDialog);
  vcr = inject(ViewContainerRef);
  overlay = inject(Overlay);
  open(kind) {
    if (kind === 'template') return this.dialog.open(this.dialogTemplate, { autoFocus: false });
    return this.dialog.open(DialogComponent, { autoFocus: false, ...(kind === 'vcr' ? { viewContainerRef: this.vcr } : {}) });
  }
  portal(kind) {
    const ref = this.overlay.create();
    ref.attach(kind === 'component' ? new ComponentPortal(PortalComponent, this.vcr) : new TemplatePortal(this.portalTemplate, kind === 'anchored-template' ? this.portalAnchor : this.vcr));
    return ref;
  }
}
ViewChild('dialogTemplate', { static: true })(AppComponent.prototype, 'dialogTemplate');
ViewChild('portalTemplate', { static: true })(AppComponent.prototype, 'portalTemplate');
ViewChild('portalAnchor', { static: true, read: ViewContainerRef })(AppComponent.prototype, 'portalAnchor');
Component({ selector: 'fixture-root', standalone: true,
  imports: [CardComponent, RecursiveComponent, SameA, SameB, RouterOutlet, MatDialogModule, ShadowComponent],
  template: `<fixture-card class="user-card"><button data-testid="projected">Projected</button></fixture-card>
    <fixture-recursive></fixture-recursive><fixture-same-a></fixture-same-a><fixture-same-b></fixture-same-b><fixture-shadow></fixture-shadow>
    <ng-template #dialogTemplate><button data-testid="template-dialog">Template dialog</button></ng-template>
    <ng-template #portalTemplate><button data-testid="template-portal">Template portal</button></ng-template><ng-template #portalAnchor></ng-template><router-outlet></router-outlet>` })(AppComponent);
if (location.search.includes('production')) enableProdMode();
bootstrapApplication(AppComponent, { providers: [provideNoopAnimations(), provideRouter([{ path: 'lazy', loadComponent: () => import('./lazy.js').then(m => m.LazyComponent) }])] })
  .then(ref => { window.fixture = ref.components[0].instance; window.fixtureReady = true; });
